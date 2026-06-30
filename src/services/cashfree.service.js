const https = require('https');
const crypto = require('crypto');

// One single env switch decides everything else. `TEST` and `production` are
// accepted as aliases of `SANDBOX` and `PROD` so accidental misspellings still
// resolve to the right environment instead of silently picking the wrong key.
const resolveMode = () => {
  const raw = String(process.env.CASHFREE_MODE || 'TEST').toUpperCase();
  if (raw === 'PROD' || raw === 'PRODUCTION' || raw === 'LIVE') return 'PROD';
  return 'TEST';
};

const apiBase = () => {
  // Respect a manual override (handy for staging / pinned-version tests) but
  // fall back to Cashfree's documented endpoints for the resolved mode.
  if (process.env.CASHFREE_API_URL) return String(process.env.CASHFREE_API_URL).replace(/\/$/, '');
  return resolveMode() === 'PROD' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
};

const API_VERSION = process.env.CASHFREE_API_VERSION || '2025-01-01';
const APP_ID = () => process.env.CASHFREE_APP_ID || '';
const APP_SECRET = () => process.env.CASHFREE_APP_SECRET || '';

const isConfigured = () => !!(APP_ID() && APP_SECRET());

const cashfreeRequest = ({ method = 'GET', path, body }) =>
  new Promise((resolve, reject) => {
    if (!isConfigured()) {
      reject(new Error('Cashfree not configured. Set CASHFREE_APP_ID and CASHFREE_APP_SECRET in .env'));
      return;
    }

    const url = new URL(`${apiBase()}${path}`);
    const payload = body ? JSON.stringify(body) : null;

    const headers = {
      'x-api-version': API_VERSION,
      'x-client-id': APP_ID(),
      'x-client-secret': APP_SECRET(),
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }
          const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
          const err = new Error(`Cashfree ${method} ${path} failed (${res.statusCode}): ${detail}`);
          err.statusCode = res.statusCode;
          err.body = parsed;
          reject(err);
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

/**
 * Normalize a phone number to a form Cashfree accepts. Cashfree wants either:
 *   • Indian 10-digit: "9090407368" or with country code "+919090407368"
 *   • International with country code: "+16014635923"
 *
 * Our DB stores whatever the user typed at signup (often with spaces, dashes,
 * or a stray leading 0). We clean it here so the booking-create path doesn't
 * have to know Cashfree's exact rules.
 *
 * Returns null if the number can't be salvaged — caller treats that as an
 * invalid phone and surfaces a friendly error to the user.
 */
const normalizePhone = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  // Preserve a leading + if present; otherwise strip everything except digits.
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (hasPlus) {
    // International number — must be at least 11 digits (1 country + 10 local).
    return digits.length >= 11 ? `+${digits}` : null;
  }

  // Indian: 10 digits → prepend +91. 12 digits starting with 91 → prepend +.
  // 11 digits starting with 0 → drop the 0, treat as 10-digit Indian.
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;

  // Anything else — too short or weird length. Bail rather than send garbage.
  return null;
};

/**
 * Create a Cashfree order for a booking. Returns the `payment_session_id`
 * the frontend SDK needs to render the hosted checkout.
 *
 *   - We use the human-readable bookingCode as Cashfree's order_id so support
 *     tickets and webhook payloads tie back to a booking without a join.
 *   - return_url has `{order_id}` as a literal so Cashfree substitutes it at
 *     redirect time. This means /booking-success/RBT-2026-XYZ is the actual
 *     landing URL the browser hits after a successful payment.
 */
const createOrder = async ({
  bookingCode,
  amount,             // rupees (decimal) — Cashfree expects rupees, not paise
  currency = 'INR',
  customer,           // { id, name, email, phone }
  returnUrl,          // browser redirect after payment
  notifyUrl,          // server-to-server webhook
  note,               // optional human-readable note
}) => {
  // Cashfree rejects bare 9-digit numbers and anything with stray punctuation
  // with `customer_details.customer_phone_invalid` (400). Normalize upfront
  // so a saved-but-messy DB number doesn't take the whole booking down.
  const phone = normalizePhone(customer.phone);
  if (!phone) {
    const err = new Error(
      `Invalid phone "${customer.phone}". Please update your profile with a 10-digit Indian mobile number (or include the country code for international).`
    );
    err.code = 'invalid_phone';
    err.statusCode = 400;
    throw err;
  }

  const body = {
    order_id: bookingCode,
    order_amount: Number(amount),
    order_currency: currency,
    customer_details: {
      customer_id: String(customer.id),
      customer_name: customer.name || 'Guest',
      customer_email: customer.email,
      customer_phone: phone,
    },
    order_meta: {
      return_url: returnUrl,
      ...(notifyUrl ? { notify_url: notifyUrl } : {}),
    },
    ...(note ? { order_note: String(note).slice(0, 100) } : {}),
  };

  const res = await cashfreeRequest({ method: 'POST', path: '/orders', body });
  return {
    orderId: res.order_id,
    paymentSessionId: res.payment_session_id,
    orderStatus: res.order_status,
    cfOrderId: res.cf_order_id,
    raw: res,
  };
};

/**
 * Create a Cashfree hosted Payment Link and return its checkout URL. Used by the
 * mobile app: the app POSTs the booking amount to our backend, we create the
 * link server-to-server (so the secret never ships in the APK and the call is
 * reliable), and the app opens `linkUrl` in the browser to pay.
 */
const createPaymentLink = async ({ linkId, amount, currency = 'INR', customer = {}, purpose, returnUrl }) => {
  // A valid customer_phone is required by Cashfree; fall back to a placeholder
  // Indian number when the guest hasn't provided one (sandbox accepts it).
  const phone = normalizePhone(customer.phone) || '+919999999999';
  const body = {
    link_id: String(linkId),
    link_amount: Number(amount),
    link_currency: currency,
    link_purpose: String(purpose || 'reconnct experience').slice(0, 100),
    customer_details: {
      customer_phone: phone,
      customer_name: customer.name || 'Guest',
      customer_email: customer.email || 'guest@reconnct.app',
    },
    link_notify: { send_sms: false, send_email: false },
    ...(returnUrl ? { link_meta: { return_url: returnUrl } } : {}),
  };
  const res = await cashfreeRequest({ method: 'POST', path: '/links', body });
  return { linkUrl: res.link_url, linkId: res.link_id, raw: res };
};

/** Fetch a payment link's current state (used to poll whether it's been paid). */
const getPaymentLink = async (linkId) =>
  cashfreeRequest({ method: 'GET', path: `/links/${encodeURIComponent(linkId)}` });

/** A Cashfree payment link is settled when its status is PAID (or fully paid). */
const isLinkPaid = (link) =>
  String(link?.link_status || '').toUpperCase() === 'PAID'
  || (Number(link?.link_amount_paid || 0) > 0 && Number(link.link_amount_paid) >= Number(link.link_amount || 0));

/**
 * Look up the current status of a Cashfree order. We call this from BOTH the
 * return-URL handler (when the browser comes back) AND the webhook handler,
 * so we have a single canonical "what does Cashfree say?" answer and never
 * trust the browser to tell us a payment succeeded.
 */
const getOrder = async (orderId) =>
  cashfreeRequest({ method: 'GET', path: `/orders/${encodeURIComponent(orderId)}` });

const isPaid = (order) =>
  String(order?.order_status || '').toUpperCase() === 'PAID';

/**
 * Verify a Cashfree webhook signature. The spec (PG v3) is:
 *   signature = base64(HMAC_SHA256(timestamp + rawBody, clientSecret))
 *
 * The caller MUST pass the raw body bytes — once express.json() has parsed it
 * the original byte-for-byte string is gone and the HMAC will never match.
 */
const verifyWebhookSignature = ({ rawBody, signature, timestamp }) => {
  if (!signature || !timestamp || rawBody == null) return false;
  if (!APP_SECRET()) return false;
  const expected = crypto
    .createHmac('sha256', APP_SECRET())
    .update(String(timestamp) + String(rawBody))
    .digest('base64');
  // timingSafeEqual requires equal-length buffers — short-circuit if not.
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
};

/**
 * Initiate a refund on a paid Cashfree order. The bank then takes 5–7
 * business days to actually credit the user's source instrument — Cashfree
 * handles routing the refund back to whichever method paid (UPI / card /
 * netbanking) automatically based on the original payment.
 *
 * Required by Cashfree:
 *   - refund_id is OUR idempotency key. We use `<orderId>-r1` so multiple
 *     partial refunds against the same order would be -r1, -r2, etc.
 *   - refund_amount in rupees (decimal), refund_note as free text.
 *
 * Returns the parsed Cashfree response with fields like cf_refund_id,
 * refund_status (PENDING/SUCCESS/FAILED/CANCELLED), processed_at.
 */
const createRefund = async ({ orderId, amount, refundId, note }) => {
  if (!orderId) throw new Error('orderId is required for refund');
  const body = {
    refund_id: String(refundId || `${orderId}-r1`),
    refund_amount: Number(amount),
    refund_note: String(note || 'Booking cancelled').slice(0, 100),
  };
  return cashfreeRequest({
    method: 'POST',
    path: `/orders/${encodeURIComponent(orderId)}/refunds`,
    body,
  });
};

/**
 * Look up the status of a previously-initiated refund. Useful for the
 * "refund settled?" reconciliation job and for the admin UI to show the
 * latest status without waiting for a webhook.
 */
const getRefund = async ({ orderId, refundId }) =>
  cashfreeRequest({
    method: 'GET',
    path: `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
  });

// Mapping Cashfree's status strings to our `booking.refundStatus` enum so the
// rest of the codebase doesn't have to know Cashfree's vocabulary.
const mapCashfreeRefundStatus = (cfStatus) => {
  const s = String(cfStatus || '').toUpperCase();
  if (s === 'SUCCESS') return 'completed';
  if (s === 'FAILED' || s === 'CANCELLED') return 'failed';
  return 'processing'; // PENDING / ONHOLD / unknown → treat as in-flight
};

module.exports = {
  isConfigured,
  resolveMode,
  apiBase,
  createOrder,
  createPaymentLink,
  getPaymentLink,
  isLinkPaid,
  getOrder,
  isPaid,
  verifyWebhookSignature,
  createRefund,
  getRefund,
  mapCashfreeRefundStatus,
  normalizePhone,
};

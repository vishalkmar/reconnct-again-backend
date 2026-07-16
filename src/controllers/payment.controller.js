const asyncHandler = require('express-async-handler');
const { Booking } = require('../models');
const { ok, fail } = require('../utils/response');
const { fromPaise } = require('../services/booking.service');
const {
  createOrder: cfCreateOrder,
  createPaymentLink: cfCreatePaymentLink,
  getPaymentLink: cfGetPaymentLink,
  isLinkPaid: cfIsLinkPaid,
  getOrder: cfGetOrder,
  isPaid: cfIsPaid,
  isConfigured: cfConfigured,
  verifyWebhookSignature,
  resolveMode,
} = require('../services/cashfree.service');
const { sendBookingConfirmation, notifyHostOfBooking } = require('../services/bookingEmail.service');
const { creditReferrerForFirstPaid } = require('../services/referEarn.service');
const { sendPushToUser } = require('../services/push.service');
const { ensureCsmAssigned } = require('../services/csm.service');
const { publicBooking } = require('./booking.controller');

const clientUrl = () => {
  const raw = process.env.CLIENT_URL || 'http://localhost:5173';
  return raw.replace(/\/$/, '');
};

const appUrl = () => {
  const raw = process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`;
  return raw.replace(/\/$/, '');
};

const isFinal = (status) => ['confirmed', 'completed', 'cancelled', 'refunded'].includes(status);

// Terminal-dead order/link states — the attempt is over and will never turn
// into a payment on its own (as opposed to ACTIVE/PENDING, which might still
// resolve). Cashfree orders use one vocabulary, payment links a slightly
// different one, so we keep two small lists rather than one shared guess.
const ORDER_FAILED_STATUSES = ['EXPIRED', 'TERMINATED', 'TERMINATION_REQUESTED'];
const LINK_FAILED_STATUSES = ['EXPIRED', 'CANCELLED'];

// Records "this attempt is dead" without ever touching `status` — the booking
// stays at pending_payment so the same booking can still be retried. Never
// clobbers a booking that's already reached a final status (e.g. a stray late
// webhook for an order that was superseded by a later successful attempt).
const markPaymentFailed = async (booking, statusLabel) => {
  if (!booking || booking.status !== 'pending_payment') return;
  if (booking.paymentFailedAt && booking.lastPaymentStatus === statusLabel) return;
  booking.paymentFailedAt = new Date();
  booking.lastPaymentStatus = statusLabel || null;
  await booking.save();

  sendPushToUser(booking.userId, {
    title: 'Payment failed',
    body: `Your payment for ${booking.itemSnapshot?.name || 'your booking'} didn't go through.`,
    data: { kind: 'booking', bookingCode: booking.bookingCode, status: 'failed' },
  }).catch(() => {});

  ensureCsmAssigned(booking.userId).catch(() => {});
};

// Promote a booking to "confirmed" the first time we see a paid Cashfree
// order for it. Subsequent calls are no-ops, which is critical because both
// the return-URL handler AND the webhook may fire (and sometimes the webhook
// fires multiple times for the same payment).
const confirmBookingFromCashfree = async (booking, cfOrder) => {
  if (!booking) return null;
  if (isFinal(booking.status) && booking.status !== 'pending_payment') return booking;
  if (!cfIsPaid(cfOrder)) return booking;

  // Pick out the freshest payment in the response. Cashfree returns the
  // order with `payments[]` only when you ask for the order with payments;
  // GET /orders/:id without expansion returns the bare order. We support
  // both shapes.
  const payments = cfOrder?.payments || [];
  const latest = payments.length
    ? payments.sort((a, b) => new Date(b.payment_time || 0) - new Date(a.payment_time || 0))[0]
    : null;

  booking.status = 'confirmed';
  booking.paymentOrderId = cfOrder.order_id || booking.paymentOrderId;
  booking.paymentId = latest?.cf_payment_id || latest?.payment_id || booking.paymentId;
  booking.paymentMethod = latest?.payment_group || latest?.payment_method?.payment_method || booking.paymentMethod;
  booking.paidAt = latest?.payment_time ? new Date(latest.payment_time) : new Date();
  booking.paymentRaw = cfOrder;
  // A successful payment retracts any earlier failed-attempt marker on this
  // same booking — it's paid now, it was never really "Failed".
  booking.paymentFailedAt = null;
  booking.lastPaymentStatus = null;
  await booking.save();

  // Fire-and-forget email so a flaky SMTP doesn't make a successful payment
  // look like a failure. Logged for debugging.
  sendBookingConfirmation({ booking })
    .catch((err) => console.error('[payment] booking confirmation email failed:', err.message));

  // Tell the host (if this experience has one) that their listing was booked.
  notifyHostOfBooking({ booking })
    .catch((err) => console.error('[payment] host notification email failed:', err.message));

  // Pay the referrer their wallet credit if this is the referee's FIRST paid
  // booking. The service handles idempotency and the "is this the first?"
  // check, so we don't have to worry about firing this multiple times.
  creditReferrerForFirstPaid({ booking })
    .catch((err) => console.error('[payment] referrer payout failed:', err.message));

  sendPushToUser(booking.userId, {
    title: 'Booking confirmed',
    body: `Your booking for ${booking.itemSnapshot?.name || 'your experience'} is confirmed.`,
    data: { kind: 'booking', bookingCode: booking.bookingCode, status: 'confirmed' },
  }).catch(() => {});

  return booking;
};

// Promote a booking to "confirmed" once its Cashfree payment LINK is paid.
// Mirror of confirmBookingFromCashfree but for the mobile hosted-link flow.
const confirmBookingFromLink = async (booking, link) => {
  if (!booking) return null;
  if (booking.status === 'confirmed' || booking.status === 'completed') return booking;

  booking.status = 'confirmed';
  booking.paymentId = link?.cf_link_id ? String(link.cf_link_id) : booking.paymentId;
  booking.paymentMethod = 'cashfree_link';
  booking.paidAt = new Date();
  booking.paymentRaw = link;
  // A successful payment retracts any earlier failed-attempt marker on this
  // same booking — it's paid now, it was never really "Failed".
  booking.paymentFailedAt = null;
  booking.lastPaymentStatus = null;
  await booking.save();

  // Voucher / confirmation email — fire-and-forget so a flaky SMTP never makes
  // a successful payment look failed.
  sendBookingConfirmation({ booking })
    .catch((err) => console.error('[payment] booking confirmation email failed:', err.message));
  notifyHostOfBooking({ booking })
    .catch((err) => console.error('[payment] host notification email failed:', err.message));
  creditReferrerForFirstPaid({ booking })
    .catch((err) => console.error('[payment] referrer payout failed:', err.message));

  sendPushToUser(booking.userId, {
    title: 'Booking confirmed',
    body: `Your booking for ${booking.itemSnapshot?.name || 'your experience'} is confirmed.`,
    data: { kind: 'booking', bookingCode: booking.bookingCode, status: 'confirmed' },
  }).catch(() => {});

  return booking;
};

// POST /api/payments/links/:code  (authenticated user)
// Mobile flow: create (or reopen) a Cashfree hosted payment LINK for a booking
// and return its checkout URL. The app opens this in the browser.
const createLinkForBooking = asyncHandler(async (req, res) => {
  if (!cfConfigured()) return fail(res, 'Payments are temporarily unavailable. Please try again later.', 503);

  const code = String(req.params.code || '').trim();
  const booking = await Booking.findOne({ where: { bookingCode: code, userId: req.user.id } });
  if (!booking) return fail(res, 'Booking not found', 404);
  if (booking.status === 'confirmed' || booking.status === 'completed') return fail(res, 'This booking has already been paid', 400);
  if (booking.status === 'cancelled' || booking.status === 'refunded') return fail(res, 'This booking is no longer active', 400);

  const snap = booking.itemSnapshot || {};
  const customer = { name: booking.guestName, email: booking.guestEmail, phone: booking.guestPhone };
  const returnUrl = `${clientUrl()}/booking-success/${booking.bookingCode}`;

  // App-created (direct) link: the app made the Cashfree link itself and just
  // wants us to remember its id so link-status polling can confirm the booking.
  // No Cashfree call from here — this is the reliable on-device phase-1 path.
  const providedLinkId = req.body && req.body.linkId ? String(req.body.linkId) : null;
  const providedLinkUrl = req.body && req.body.linkUrl ? String(req.body.linkUrl) : null;
  if (providedLinkId) {
    booking.paymentOrderId = providedLinkId;
    await booking.save();
    return ok(res, { linkUrl: providedLinkUrl, bookingCode: booking.bookingCode }, 'Payment link registered');
  }

  try {
    // Reuse an existing link for this booking if one was already created.
    let linkId = booking.paymentOrderId;
    let linkUrl = null;
    if (linkId) {
      try { const existing = await cfGetPaymentLink(linkId); linkUrl = existing && existing.link_url; } catch { linkUrl = null; }
    }
    if (!linkUrl) {
      linkId = `${booking.bookingCode}-${Date.now().toString(36)}`;
      const created = await cfCreatePaymentLink({
        linkId,
        amount: fromPaise(booking.totalPaise),
        currency: booking.currency || 'INR',
        customer,
        purpose: snap.name || `Booking ${booking.bookingCode}`,
        returnUrl,
      });
      linkUrl = created.linkUrl;
      booking.paymentOrderId = linkId;
      await booking.save();
    }
    if (!linkUrl) return fail(res, 'Could not create the payment link. Please try again.', 502);
    return ok(res, { linkUrl, bookingCode: booking.bookingCode }, 'Payment link ready');
  } catch (err) {
    console.error('[payment] createLinkForBooking failed:', err.message, err.body || '');
    if (err.code === 'invalid_phone') return fail(res, err.message, 400);
    return fail(res, 'Could not initialise payment. Please try again.', 502);
  }
});

// GET /api/payments/link-status/:code  (authenticated user)
// The app polls this while/after the user pays on the hosted link. We ask
// Cashfree for the link's authoritative status and, on PAID, confirm the
// booking (+ send the voucher email). Returns the fresh DB booking.
const bookingLinkStatus = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim();
  const booking = await Booking.findOne({ where: { bookingCode: code, userId: req.user.id } });
  if (!booking) return fail(res, 'Booking not found', 404);

  if (booking.status === 'confirmed' || booking.status === 'completed') {
    return ok(res, { paid: true, booking: publicBooking(booking) });
  }
  if (!cfConfigured() || !booking.paymentOrderId) {
    return ok(res, { paid: false, failed: false, booking: publicBooking(booking) });
  }

  try {
    const link = await cfGetPaymentLink(booking.paymentOrderId);
    if (cfIsLinkPaid(link)) {
      await confirmBookingFromLink(booking, link);
      await booking.reload();
      return ok(res, { paid: true, booking: publicBooking(booking) });
    }
    const linkStatus = link?.link_status || null;
    const failed = LINK_FAILED_STATUSES.includes(String(linkStatus || '').toUpperCase());
    if (failed) {
      await markPaymentFailed(booking, linkStatus);
      await booking.reload();
    }
    return ok(res, { paid: false, failed, booking: publicBooking(booking), linkStatus });
  } catch (err) {
    console.error('[payment] link-status failed:', err.message, err.body || '');
    return fail(res, 'Could not check payment status. Please try again in a moment.', 502);
  }
});

// POST /api/payments/orders/:code  (authenticated user)
// Creates (or re-uses) a Cashfree order for this booking and returns the
// payment_session_id the frontend SDK needs to launch hosted checkout.
const createOrderForBooking = asyncHandler(async (req, res) => {
  if (!cfConfigured()) {
    return fail(res, 'Payments are temporarily unavailable. Please try again later.', 503);
  }

  const code = String(req.params.code || '').trim();
  const booking = await Booking.findOne({ where: { bookingCode: code, userId: req.user.id } });
  if (!booking) return fail(res, 'Booking not found', 404);

  if (booking.status === 'confirmed' || booking.status === 'completed') {
    return fail(res, 'This booking has already been paid', 400);
  }
  if (booking.status === 'cancelled' || booking.status === 'refunded') {
    return fail(res, 'This booking is no longer active', 400);
  }

  const returnUrl = `${clientUrl()}/booking-success/${booking.bookingCode}?cf_order_id={order_id}`;
  const notifyUrl = `${appUrl()}/api/payments/webhook`;

  try {
    const result = await cfCreateOrder({
      bookingCode: booking.bookingCode,
      amount: fromPaise(booking.totalPaise),
      currency: booking.currency || 'INR',
      customer: {
        id: req.user.id,
        name: booking.guestName,
        email: booking.guestEmail,
        phone: booking.guestPhone,
      },
      returnUrl,
      notifyUrl,
      note: `Booking ${booking.bookingCode} (${booking.itemType})`,
    });

    // Cashfree returns the new order_id; record it so the webhook & return
    // handlers can lookup-by-orderId later without an extra round-trip.
    booking.paymentOrderId = result.orderId || booking.paymentOrderId;
    await booking.save();

    return ok(res, {
      orderId: result.orderId,
      paymentSessionId: result.paymentSessionId,
      mode: resolveMode().toLowerCase(),  // "test" | "prod" → frontend SDK config
      bookingCode: booking.bookingCode,
    }, 'Cashfree order ready');
  } catch (err) {
    console.error('[payment] createOrder failed:', err.message, err.body || '');

    // Surface Cashfree validation errors (bad phone, bad email, etc.) directly
    // to the user as a 400 so they can fix their profile and retry. Unknown
    // upstream errors stay as a generic 502 so we don't leak Cashfree internals.
    if (err.code === 'invalid_phone') {
      return fail(res, err.message, 400);
    }
    if (err.statusCode === 400 && err.body?.code) {
      // Cashfree returned a structured validation failure. The `message`
      // field is usually safe to relay to the user.
      const cfMsg = err.body.message || 'Payment details were rejected by the gateway.';
      return fail(res, cfMsg, 400);
    }
    return fail(res, 'Could not initialise payment. Please try again.', 502);
  }
});

// GET /api/payments/verify/:code  (authenticated user)
// The return-URL handler. The browser is back from Cashfree — we DON'T trust
// what it tells us about the payment. We make a fresh GET /pg/orders/:id call
// and use Cashfree's authoritative answer to flip the booking to confirmed.
const verifyBookingPayment = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim();
  const booking = await Booking.findOne({ where: { bookingCode: code, userId: req.user.id } });
  if (!booking) return fail(res, 'Booking not found', 404);

  // Short-circuit when we've already confirmed this booking. Lets the success
  // page poll harmlessly without burning Cashfree quota.
  if (booking.status === 'confirmed' || booking.status === 'completed') {
    return ok(res, { booking: publicBooking(booking), paid: true });
  }

  if (!cfConfigured()) return fail(res, 'Payment provider not configured', 503);

  try {
    const cfOrder = await cfGetOrder(booking.paymentOrderId || booking.bookingCode);
    if (cfIsPaid(cfOrder)) {
      await confirmBookingFromCashfree(booking, cfOrder);
      await booking.reload();
      return ok(res, { booking: publicBooking(booking), paid: true });
    }
    const orderStatus = cfOrder?.order_status || null;
    const failed = ORDER_FAILED_STATUSES.includes(String(orderStatus || '').toUpperCase());
    if (failed) {
      await markPaymentFailed(booking, orderStatus);
      await booking.reload();
    }
    return ok(res, {
      booking: publicBooking(booking),
      paid: false,
      failed,
      cfOrderStatus: orderStatus,
    });
  } catch (err) {
    console.error('[payment] verify failed:', err.message, err.body || '');
    return fail(res, 'Could not verify payment. Please try again in a moment.', 502);
  }
});

// POST /api/payments/webhook  (Cashfree → us, server-to-server)
// Mounted with express.raw() so we can verify the HMAC on the original bytes.
// We deliberately keep this lean: verify → look up booking → confirm if paid.
const webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');

  if (!verifyWebhookSignature({ rawBody, signature, timestamp })) {
    console.warn('[payment] webhook signature failed — ignoring payload');
    return res.status(401).json({ success: false });
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return res.status(400).json({ success: false }); }

  // Cashfree's PG webhook payload shape:
  //   { type: 'PAYMENT_SUCCESS_WEBHOOK' | ..., data: { order: {...}, payment: {...} } }
  const eventType = String(payload?.type || '').toUpperCase();
  const orderId = payload?.data?.order?.order_id;
  if (!orderId) return res.status(200).json({ success: true }); // ack but ignore

  const booking = await Booking.findOne({ where: { paymentOrderId: orderId } })
    || await Booking.findOne({ where: { bookingCode: orderId } });
  if (!booking) {
    console.warn('[payment] webhook for unknown order:', orderId);
    return res.status(200).json({ success: true });
  }

  // We re-fetch the order to be triple-sure rather than trusting the payload.
  // Cashfree itself recommends this — the webhook is the trigger, the GET
  // is the source of truth.
  try {
    const cfOrder = await cfGetOrder(orderId);
    if (eventType.includes('SUCCESS') || cfIsPaid(cfOrder)) {
      await confirmBookingFromCashfree(booking, cfOrder);
    } else if (eventType.includes('FAIL') || eventType.includes('USER_DROPPED')) {
      // Don't change `status` — leave at pending_payment so the user can
      // retry the same booking. Just record that this attempt is dead so the
      // Transactions tab can show it as Failed instead of stuck Pending.
      await markPaymentFailed(booking, eventType);
      console.log('[payment] webhook payment failure for', orderId, eventType);
    }
  } catch (err) {
    console.error('[payment] webhook handling error:', err.message);
  }

  return res.status(200).json({ success: true });
});

module.exports = {
  createOrderForBooking,
  createLinkForBooking,
  bookingLinkStatus,
  verifyBookingPayment,
  webhook,
};

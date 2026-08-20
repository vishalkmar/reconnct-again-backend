const {
  FraudEvent, FraudBlockedEmail, User, Booking,
} = require('../models');
const { send } = require('../pwa/services/mailer');
const {
  emailShell, kvTable, calloutBox, escapeHtml,
} = require('../utils/emailLayout');
const { emitSecurity } = require('./securitySocket');

/*
  Payment-fraud detection.

  The attack: a customer opens the booking/pay request in Burp (or any MITM),
  lowers the amount forwarded to the payment gateway, pays that smaller amount,
  and the gateway reports success — so the booking confirms even though LESS was
  paid than the item actually costs.

  We catch it at confirmation time by comparing:
     expected  = booking.totalPaise   (server-computed at booking creation;
                                        the coupon a user legitimately applied is
                                        ALREADY subtracted into this, so a valid
                                        coupon never triggers a false positive)
     paid      = the amount the gateway actually collected
  If paid is materially LESS than expected → fraud.

  Everything here is fire-and-forget from the payment flow and fully guarded:
  a failure in detection can NEVER break a legitimate confirmation.
*/

// Whom to alert. Overridable via env; defaults to the address the user gave.
const ADMIN_ALERT_EMAIL = process.env.FRAUD_ALERT_EMAIL || 'vk722413@gmail.com';
// Ignore sub-rupee rounding noise between our paise math and the gateway.
const TOLERANCE_PAISE = 100; // ₹1

const rupee = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// What the gateway actually collected, in paise, from a Cashfree order object.
const paidPaiseFromOrder = (cfOrder) => {
  if (!cfOrder) return 0;
  const payments = Array.isArray(cfOrder.payments) ? cfOrder.payments : [];
  const paid = payments.filter((p) => String(p.payment_status || '').toUpperCase() === 'SUCCESS');
  if (paid.length) {
    const sum = paid.reduce((a, p) => a + (Number(p.payment_amount) || 0), 0);
    return Math.round(sum * 100);
  }
  // Bare order (no expanded payments) — the order amount is what was charged.
  return Math.round((Number(cfOrder.order_amount) || 0) * 100);
};

// Bank / instrument details out of the gateway payload, for the evidence blob.
const paymentEvidence = (cfOrder, booking) => {
  const payments = Array.isArray(cfOrder?.payments) ? cfOrder.payments : [];
  const latest = payments.length
    ? payments.slice().sort((a, b) => new Date(b.payment_time || 0) - new Date(a.payment_time || 0))[0]
    : null;
  const method = latest?.payment_method || {};
  const instrument = method.upi || method.card || method.netbanking || method.app || {};
  return {
    cfOrderId: cfOrder?.order_id || booking.paymentOrderId || null,
    paymentId: latest?.cf_payment_id || latest?.payment_id || booking.paymentId || null,
    method: latest?.payment_group || Object.keys(method)[0] || booking.paymentMethod || null,
    paymentStatus: latest?.payment_status || null,
    paymentTime: latest?.payment_time || null,
    bank: instrument.bank_name || instrument.upi_id || instrument.card_bank_name || null,
    instrumentHint: instrument.card_number || instrument.upi_id || null, // masked by Cashfree
    orderAmount: cfOrder?.order_amount ?? null,
    orderCurrency: cfOrder?.order_currency ?? null,
  };
};

// ── Freeze list (email-keyed) ───────────────────────────────────────────────
const isEmailBlocked = async (email) => {
  const clean = String(email || '').toLowerCase().trim();
  if (!clean) return false;
  try {
    const row = await FraudBlockedEmail.findOne({ where: { email: clean, isActive: true } });
    return !!row;
  } catch { return false; } // never let a lookup failure block a legit login
};

const freezeEmail = async ({ email, reason, bookingCode, fraudEventId }) => {
  const clean = String(email || '').toLowerCase().trim();
  if (!clean) return;
  const [row, created] = await FraudBlockedEmail.findOrCreate({
    where: { email: clean },
    defaults: {
      email: clean, reason, bookingCode, fraudEventId, isActive: true, frozenAt: new Date(),
    },
  });
  if (!created) {
    await row.update({
      isActive: true, reason, bookingCode, fraudEventId, frozenAt: new Date(), unfrozenAt: null, unfrozenByAdminId: null,
    });
  }
  // Also flip the existing user row inactive so any live session is rejected.
  try { await User.update({ isActive: false }, { where: { email: clean } }); } catch { /* ignore */ }
};

// ── Emails ──────────────────────────────────────────────────────────────────
const emailAdmin = (ev, ctx) => {
  const c = ctx || {};
  const rows = [
    ['Booking code', escapeHtml(ev.bookingCode || '—')],
    ['Customer', escapeHtml(`${ev.userName || '—'} · ${ev.userEmail || '—'}`)],
    ['Phone', escapeHtml(ev.userPhone || '—')],
    ['Item', escapeHtml(ev.itemDetails?.name || '—')],
    ['For date', escapeHtml(ev.itemDetails?.scheduledFor || '—')],
    ['Booked at', escapeHtml(ev.itemDetails?.bookedAt || '—')],
    ['Expected amount', `<b>${rupee(ev.expectedPaise)}</b>`],
    ['Actually paid', `<b style="color:#dc2626;">${rupee(ev.paidPaise)}</b>`],
    ['Shortfall', `<b style="color:#dc2626;">${rupee(ev.shortfallPaise)}</b>`],
    ev.couponCode ? ['Coupon used', `${escapeHtml(ev.couponCode)} (−${rupee(ev.couponDiscountPaise)}) — already accounted`] : null,
    ['Payment ID', escapeHtml(ev.paymentDetails?.paymentId || '—')],
    ['Method / bank', escapeHtml(`${ev.paymentDetails?.method || '—'} · ${ev.paymentDetails?.bank || '—'}`)],
    ['IP address', escapeHtml(c.ip || '—')],
    ['Device', escapeHtml(c.deviceId || '—')],
    ['System', escapeHtml(c.systemInfo || '—')],
    ['Location', escapeHtml(typeof c.location === 'object' ? JSON.stringify(c.location) : (c.location || '—'))],
    ['Network', escapeHtml(c.network || '—')],
    ['User agent', escapeHtml(c.userAgent || '—')],
  ];
  const html = emailShell({
    preheader: `Payment fraud detected on ${ev.bookingCode} — short by ${rupee(ev.shortfallPaise)}`,
    bodyHtml: `
      <h2 style="margin:0 0 6px;color:#dc2626;font-size:20px;">⚠️ Payment fraud detected</h2>
      <p style="color:#374151;line-height:1.6;margin:0 0 6px;">
        A booking was confirmed for <b>less</b> than it should cost — the gateway amount looks tampered.
      </p>
      ${calloutBox('Shortfall', `<span style="color:#dc2626;">${rupee(ev.shortfallPaise)}</span>`, `${rupee(ev.paidPaise)} paid vs ${rupee(ev.expectedPaise)} expected`)}
      ${kvTable(rows)}
      <p style="color:#94a3b8;font-size:12px;margin:14px 0 0;">
        The customer's account has been frozen automatically. Review it in Admin → Security → Payment Fraud Detection.
      </p>
    `,
  });
  return send({ to: ADMIN_ALERT_EMAIL, subject: `⚠️ Payment fraud: ${ev.bookingCode} (short ${rupee(ev.shortfallPaise)})`, html, text: `Fraud on ${ev.bookingCode}: paid ${rupee(ev.paidPaise)} vs expected ${rupee(ev.expectedPaise)}` });
};

const emailUser = (ev) => {
  if (!ev.userEmail) return Promise.resolve();
  const html = emailShell({
    preheader: 'Important: an issue was found with your recent payment',
    bodyHtml: `
      <h2 style="margin:0 0 10px;color:#dc2626;font-size:19px;">A problem was found with your payment</h2>
      <p style="color:#374151;line-height:1.6;margin:0 0 10px;">
        Our systems detected that the payment on booking <b>${escapeHtml(ev.bookingCode || '')}</b> did not match the
        amount due for what you booked. This has been flagged as a <b>fraudulent / manipulated payment</b>.
      </p>
      <p style="color:#374151;line-height:1.6;margin:0 0 10px;">
        For your protection your account has been <b>frozen</b> and you will not be able to sign in while this is
        reviewed. Tampering with a payment is a serious matter and <b>legal action may be taken</b>.
      </p>
      <p style="color:#374151;line-height:1.6;margin:0;">
        If you believe this is a mistake, reply to this email so our team can look into it.
      </p>
    `,
  });
  return send({ to: ev.userEmail, subject: 'Action required: an issue with your payment', html, text: 'A fraudulent/manipulated payment was detected on your booking; your account has been frozen.' });
};

// Shared tail: freeze the account, push the real-time alert, and send the two
// emails. Used by BOTH the real detection and the admin test simulation, so a
// test exercises the exact same pipeline that a genuine fraud does.
const raiseFraud = async (ev, ctx) => {
  await freezeEmail({
    email: ev.userEmail, reason: `Payment fraud on ${ev.bookingCode}`, bookingCode: ev.bookingCode, fraudEventId: ev.id,
  }).catch((e) => console.error('[fraud] freeze failed:', e.message));

  emitSecurity('fraud:new', {
    id: ev.id,
    bookingCode: ev.bookingCode,
    userEmail: ev.userEmail,
    userName: ev.userName,
    expected: ev.expectedPaise / 100,
    paid: ev.paidPaise / 100,
    shortfall: ev.shortfallPaise / 100,
    detectedAt: ev.detectedAt,
    simulated: !!ev.itemDetails?.simulated,
  });

  emailAdmin(ev, ctx || ev.clientContext || {}).catch((e) => console.error('[fraud] admin email failed:', e.message));
  emailUser(ev).catch((e) => console.error('[fraud] user email failed:', e.message));
};

// ── Main entry ──────────────────────────────────────────────────────────────
/*
  Call AFTER a booking is confirmed. Returns the FraudEvent if one was raised,
  else null. Never throws — any error is swallowed and logged.
*/
const evaluateBookingPayment = async ({ booking, cfOrder }) => {
  try {
    if (!booking || booking.itemType !== 'experience') return null;

    const expectedPaise = Number(booking.totalPaise) || 0;
    const paidPaise = paidPaiseFromOrder(cfOrder);
    // No evidence of what was paid, or nothing expected → can't judge.
    if (expectedPaise <= 0 || paidPaise <= 0) return null;

    const shortfall = expectedPaise - paidPaise;
    if (shortfall <= TOLERANCE_PAISE) return null; // paid enough (or more) — fine

    // Don't double-raise for the same booking (webhook fires repeatedly).
    const existing = await FraudEvent.findOne({ where: { bookingId: booking.id } });
    if (existing) return existing;

    const user = booking.userId ? await User.findByPk(booking.userId) : null;
    const snap = booking.itemSnapshot || {};
    const ctx = booking.clientContext || {};

    const ev = await FraudEvent.create({
      userId: booking.userId || null,
      userEmail: (user?.email || booking.guestEmail || '').toLowerCase() || null,
      userName: user?.name || booking.guestName || null,
      userPhone: user?.phone || booking.guestPhone || null,
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      currency: booking.currency || 'INR',
      expectedPaise,
      paidPaise,
      shortfallPaise: shortfall,
      couponCode: booking.couponCode || null,
      couponDiscountPaise: Number(booking.couponDiscountPaise) || 0,
      reason: 'amount_tampered',
      severity: 'high',
      paymentDetails: paymentEvidence(cfOrder, booking),
      itemDetails: {
        type: booking.itemType,
        id: booking.itemId,
        name: snap.name || null,
        scheduledFor: booking.scheduledFor || null,
        bookedAt: booking.createdAt ? new Date(booking.createdAt).toISOString() : new Date().toISOString(),
        guestCount: booking.guestCount,
        snapshot: snap,
      },
      clientContext: ctx,
      status: 'open',
      detectedAt: new Date(),
    });

    // Freeze + alert + emails (same pipeline the test simulation uses).
    await raiseFraud(ev, ctx);

    console.warn(`[fraud] DETECTED on ${ev.bookingCode}: paid ${paidPaise} vs expected ${expectedPaise} (short ${shortfall})`);
    return ev;
  } catch (err) {
    console.error('[fraud] evaluation error (non-fatal):', err.message);
    return null;
  }
};

/*
  Admin test tool — reproduce the ENTIRE fraud pipeline (event → freeze →
  admin+user email → real-time socket) on the live platform, without needing
  Burp/MITM. Uses a caller-supplied test email as the "fraudster" so nothing
  touches a real customer. Only reachable when FRAUD_TEST_ENABLED=true and by an
  admin (gated at the route). `simulated:true` is stamped so it can't be mistaken
  for a genuine case.
*/
const simulateFraudEvent = async ({
  email, name, expectedPaise, paidPaise, ctx,
}) => {
  const cleanEmail = String(email || '').toLowerCase().trim();
  const exp = Math.max(0, Math.round(Number(expectedPaise) || 0));
  const paid = Math.max(0, Math.round(Number(paidPaise) || 0));
  const shortfall = Math.max(0, exp - paid);
  const context = {
    ip: '203.0.113.10 (simulated)',
    userAgent: 'Simulated test — Admin Security dashboard',
    systemInfo: 'Test simulation',
    deviceId: 'test-device',
    location: 'Test',
    network: 'test',
    capturedAt: new Date().toISOString(),
    ...(ctx || {}),
  };

  const ev = await FraudEvent.create({
    userEmail: cleanEmail || null,
    userName: name || 'Test user',
    userPhone: null,
    bookingCode: `SIM-${Date.now().toString(36).toUpperCase()}`,
    currency: 'INR',
    expectedPaise: exp,
    paidPaise: paid,
    shortfallPaise: shortfall,
    reason: 'amount_tampered',
    severity: 'high',
    paymentDetails: { method: 'simulated', bank: 'Test Bank', paymentId: 'SIM-PAY', orderAmount: paid / 100 },
    itemDetails: { name: 'Simulated booking (test)', simulated: true, bookedAt: new Date().toISOString() },
    clientContext: context,
    status: 'open',
    detectedAt: new Date(),
  });

  await raiseFraud(ev, context);
  return ev;
};

module.exports = {
  evaluateBookingPayment,
  simulateFraudEvent,
  isEmailBlocked,
  freezeEmail,
  paidPaiseFromOrder,
  ADMIN_ALERT_EMAIL,
};

const { Op } = require('sequelize');
const {
  Booking,
  Package,
  AvailableRoom,
  Event,
  AddOnActivity,
  RefundPolicy,
  sequelize,
} = require('../models');
const {
  createRefund: cfCreateRefund,
  getRefund: cfGetRefund,
  mapCashfreeRefundStatus,
  isConfigured: cfConfigured,
} = require('./cashfree.service');
const { fromPaise } = require('./booking.service');
const { refundWalletForBooking } = require('./referEarn.service');

// ─── Policy resolution ────────────────────────────────────────────────────
// Returns { tiers, enabled, processingNote, source } where `source` is
// "item-override" | "global" | "default-hardcoded". We never throw — if the
// global row isn't seeded yet we fall back to a sane default so cancel keeps
// working even on a brand-new DB.

const HARD_DEFAULT = {
  tiers: [
    { hoursBeforeCheckIn: 72, refundPercent: 100, label: '72+ hours before check-in' },
    { hoursBeforeCheckIn: 48, refundPercent: 50,  label: '48–72 hours before check-in' },
    { hoursBeforeCheckIn: 0,  refundPercent: 0,   label: 'Within 24 hours of check-in' },
  ],
  enabled: true,
  processingNote: 'Refunds are processed instantly on our end. The amount will reflect in your original payment method within 5–7 business days.',
};

const loadGlobalPolicy = async () => {
  try {
    const row = await RefundPolicy.findByPk(1);
    if (!row) return { ...HARD_DEFAULT, source: 'default-hardcoded' };
    return {
      tiers: Array.isArray(row.tiers) && row.tiers.length ? row.tiers : HARD_DEFAULT.tiers,
      enabled: row.enabled !== false,
      processingNote: row.processingNote || HARD_DEFAULT.processingNote,
      source: 'global',
    };
  } catch {
    return { ...HARD_DEFAULT, source: 'default-hardcoded' };
  }
};

// Look up the underlying item (package/room/event/addon) and pull the
// `isRefundable` flag + any `refundPolicyOverride`. Returns null fields if
// the item has since been deleted — caller treats that like global policy
// with no override.
const fetchItemFlags = async (itemType, itemId) => {
  let row = null;
  if (itemType === 'package') row = await Package.findByPk(itemId, { attributes: ['isRefundable', 'refundPolicyOverride'] });
  else if (itemType === 'room') row = await AvailableRoom.findByPk(itemId, { attributes: ['isRefundable', 'refundPolicyOverride'] });
  else if (itemType === 'event') row = await Event.findByPk(itemId, { attributes: ['isRefundable', 'refundPolicyOverride'] });
  else if (itemType === 'addon') row = await AddOnActivity.findByPk(itemId, { attributes: ['isRefundable', 'refundPolicyOverride'] });
  if (!row) return { isRefundable: true, refundPolicyOverride: null };
  return {
    isRefundable: row.isRefundable !== false,
    refundPolicyOverride: row.refundPolicyOverride || null,
  };
};

const resolvePolicyForBooking = async (booking) => {
  const global = await loadGlobalPolicy();
  const itemFlags = await fetchItemFlags(booking.itemType, booking.itemId);

  if (!itemFlags.isRefundable) {
    return {
      tiers: [{ hoursBeforeCheckIn: 0, refundPercent: 0, label: 'This item is non-refundable' }],
      enabled: global.enabled,
      processingNote: global.processingNote,
      source: 'item-non-refundable',
      isRefundable: false,
    };
  }

  if (Array.isArray(itemFlags.refundPolicyOverride) && itemFlags.refundPolicyOverride.length) {
    return {
      tiers: itemFlags.refundPolicyOverride,
      enabled: global.enabled,
      processingNote: global.processingNote,
      source: 'item-override',
      isRefundable: true,
    };
  }

  return { ...global, isRefundable: true };
};

// ─── Tier evaluation ──────────────────────────────────────────────────────
// Given the resolved policy and the booking's scheduledFor date, compute the
// refund percent that applies right now + the breakdown the UI needs.

const computeRefundQuote = (policy, booking) => {
  // scheduledFor is the check-in / event date. We treat it as start-of-day
  // in the server's timezone, matching how the admin enters dates.
  const checkInIso = booking.scheduledFor;
  if (!checkInIso) {
    // No scheduled date (rare — should only happen for legacy data). Treat
    // as fully refundable since we can't compute hours.
    return {
      eligible: policy.isRefundable !== false,
      refundPercent: 100,
      hoursToCheckIn: null,
      tier: { hoursBeforeCheckIn: 0, refundPercent: 100, label: 'No scheduled date — full refund' },
      refundAmount: fromPaise(booking.totalPaise || 0),
      refundAmountPaise: booking.totalPaise || 0,
      nonRefundableAmount: 0,
      processingNote: policy.processingNote,
      policySource: policy.source,
    };
  }

  const checkInDate = new Date(`${checkInIso}T00:00:00`);
  const now = new Date();
  const hoursToCheckIn = (checkInDate - now) / (1000 * 60 * 60);

  // Tiers sorted high → low; first one whose threshold <= hoursToCheckIn wins.
  const sorted = [...(policy.tiers || [])].sort((a, b) => (b.hoursBeforeCheckIn || 0) - (a.hoursBeforeCheckIn || 0));
  const tier = sorted.find((t) => hoursToCheckIn >= (t.hoursBeforeCheckIn || 0))
    || { hoursBeforeCheckIn: 0, refundPercent: 0, label: 'Outside refund window' };

  const refundPercent = Math.max(0, Math.min(100, Number(tier.refundPercent) || 0));
  const refundPaise = Math.floor(((booking.totalPaise || 0) * refundPercent) / 100);

  return {
    eligible: refundPercent > 0,
    refundPercent,
    hoursToCheckIn: Math.round(hoursToCheckIn * 10) / 10,
    tier,
    refundAmount: fromPaise(refundPaise),
    refundAmountPaise: refundPaise,
    nonRefundableAmount: fromPaise((booking.totalPaise || 0) - refundPaise),
    processingNote: policy.processingNote,
    policySource: policy.source,
  };
};

// Convenience: full quote in one call.
const quoteForBooking = async (booking) => {
  const policy = await resolvePolicyForBooking(booking);
  return { policy, quote: computeRefundQuote(policy, booking) };
};

// ─── Refund execution ─────────────────────────────────────────────────────
// Two paths: cashfree (when the booking was paid via Cashfree) and
// wallet-only (when totalPaise is fully covered by walletDiscountPaise, or
// the user never actually paid through Cashfree — e.g. ₹0 promo booking).

const executeRefund = async ({ booking, quote, reason }) => {
  if (!quote.refundAmountPaise || quote.refundAmountPaise <= 0) {
    return { kind: 'none', refundStatus: 'none', refundAmount: 0 };
  }

  // Always restore wallet + coupon usage first (regardless of payment path)
  // so the user gets their credit/coupon back immediately for free re-use.
  if (booking.walletDiscountPaise > 0) {
    await refundWalletForBooking({
      userId: booking.userId,
      amountPaise: booking.walletDiscountPaise,
      bookingId: booking.id,
    }).catch((err) => console.error('[refund] wallet restore failed:', err.message));
  }

  // Cashfree refund — only if the booking actually has a Cashfree order id
  // AND Cashfree is configured. For unpaid bookings (status pending_payment)
  // we never hit this path because the cancel flow short-circuits earlier.
  const hasCfOrder = !!(booking.paymentOrderId && booking.paidAt);
  if (!hasCfOrder || !cfConfigured()) {
    // Nothing to push to Cashfree. Mark wallet-only refund completed.
    booking.refundStatus = 'completed';
    booking.refundAmountPaise = quote.refundAmountPaise;
    booking.refundedAt = new Date();
    await booking.save();
    return { kind: 'wallet-only', refundStatus: 'completed', refundAmount: quote.refundAmount };
  }

  // Cashfree path — kick off the refund. We use bookingCode-r1 as the
  // refund_id so we have a deterministic, debuggable idempotency key.
  const refundId = `${booking.bookingCode}-r1`;
  try {
    const cfResp = await cfCreateRefund({
      orderId: booking.paymentOrderId,
      amount: quote.refundAmount,
      refundId,
      note: reason ? String(reason).slice(0, 90) : `Cancellation refund — ${quote.refundPercent}%`,
    });

    const mapped = mapCashfreeRefundStatus(cfResp?.refund_status);
    booking.refundStatus = mapped;
    booking.cashfreeRefundId = cfResp?.cf_refund_id || refundId;
    booking.refundAmountPaise = quote.refundAmountPaise;
    booking.refundedAt = new Date();
    booking.refundRaw = cfResp;
    await booking.save();
    return {
      kind: 'cashfree',
      refundStatus: mapped,
      refundAmount: quote.refundAmount,
      cashfreeRefundId: booking.cashfreeRefundId,
      raw: cfResp,
    };
  } catch (err) {
    // Refund call failed at Cashfree (e.g. amount exceeds settled balance).
    // We mark the booking as `failed` so admin can retry; the user's wallet
    // restore above is already done, so they at least get credit back.
    console.error('[refund] cashfree refund failed:', err.message, err.body || '');
    booking.refundStatus = 'failed';
    booking.refundAmountPaise = quote.refundAmountPaise;
    booking.refundRaw = { error: err.message, body: err.body || null };
    await booking.save();
    return {
      kind: 'cashfree-failed',
      refundStatus: 'failed',
      refundAmount: quote.refundAmount,
      error: err.message,
    };
  }
};

// Reconcile a single booking's refund with Cashfree. Used by the admin UI to
// "refresh" a stuck refund + by a background job (future).
const reconcileRefundStatus = async ({ booking }) => {
  if (!booking.cashfreeRefundId || !booking.paymentOrderId) return null;
  if (booking.refundStatus === 'completed' || booking.refundStatus === 'none') return null;
  if (!cfConfigured()) return null;
  try {
    const cfResp = await cfGetRefund({
      orderId: booking.paymentOrderId,
      refundId: booking.cashfreeRefundId.startsWith(booking.bookingCode)
        ? booking.cashfreeRefundId
        : `${booking.bookingCode}-r1`,
    });
    const mapped = mapCashfreeRefundStatus(cfResp?.refund_status);
    if (mapped !== booking.refundStatus) {
      booking.refundStatus = mapped;
      booking.refundRaw = cfResp;
      await booking.save();
    }
    return { refundStatus: mapped, raw: cfResp };
  } catch (err) {
    console.error('[refund] reconcile failed:', err.message);
    return null;
  }
};

module.exports = {
  HARD_DEFAULT,
  loadGlobalPolicy,
  resolvePolicyForBooking,
  computeRefundQuote,
  quoteForBooking,
  executeRefund,
  reconcileRefundStatus,
};

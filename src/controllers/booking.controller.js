const asyncHandler = require('express-async-handler');
const { Booking, User, Review } = require('../models');
const { ok, fail, created } = require('../utils/response');
const {
  ALLOWED_TYPES,
  fetchItem,
  computePricing,
  buildItemSnapshot,
  resolveSchedule,
  resolveScheduledAt,
  generateBookingCode,
  fromPaise,
} = require('../services/booking.service');
const {
  validateCouponFor,
  consumeCoupon,
  restoreCoupon,
  debitWalletForBooking,
  refundWalletForBooking,
  capWalletForBooking,
  loadConfig: loadReferralConfig,
} = require('../services/referEarn.service');

const normalizeType = (t) => String(t || '').toLowerCase().trim();

// Parse the optional extra-guest list from a request. Accepts an array (or
// JSON string) of { age }. Caps at 20 to keep maths sane.
const parseExtraPersons = (raw) => {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => ({ age: parseInt(p?.age, 10), bed: p?.bed === 'with' ? 'with' : 'without' }))
    .filter((p) => Number.isInteger(p.age) && p.age >= 0 && p.age <= 120)
    .slice(0, 20);
};

const publicBooking = (booking) => {
  if (!booking) return null;
  const j = booking.toJSON ? booking.toJSON() : booking;
  const gstPaise = j.gstPaise || (j.taxPaise && !j.tcsPaise ? j.taxPaise : 0);
  const tcsPaise = j.tcsPaise || 0;
  return {
    id: j.id,
    bookingCode: j.bookingCode,
    status: j.status,
    itemType: j.itemType,
    itemId: j.itemId,
    item: j.itemSnapshot,
    scheduledFor: j.scheduledFor,
    scheduledEndAt: j.scheduledEndAt,
    // Full timestamp (date-only scheduledFor/scheduledEndAt above can't tell
    // "already happened today" from "later today") — the client-side
    // completed check needs this to agree with the backend's isCompletedNow.
    scheduledAt: j.scheduledAt,
    units: j.units,
    guest: {
      name: j.guestName,
      email: j.guestEmail,
      phone: j.guestPhone,
      count: j.guestCount,
    },
    roomCount: j.roomCount || 1,
    specialRequests: j.specialRequests,
    currency: j.currency,
    pricing: {
      unitPrice: fromPaise(j.unitPricePaise),
      subtotal: fromPaise(j.subtotalPaise),
      gst: fromPaise(gstPaise),
      tcs: fromPaise(tcsPaise),
      tax: fromPaise(j.taxPaise),
      walletDiscount: fromPaise(j.walletDiscountPaise),
      couponDiscount: fromPaise(j.couponDiscountPaise),
      couponCode: j.couponCode,
      total: fromPaise(j.totalPaise),
    },
    payment: {
      orderId: j.paymentOrderId,
      paymentId: j.paymentId,
      method: j.paymentMethod,
      paidAt: j.paidAt,
    },
    cancelledAt: j.cancelledAt,
    cancellationReason: j.cancellationReason,
    cancellationReasonCode: j.cancellationReasonCode,
    refundedAt: j.refundedAt,
    refundAmount: fromPaise(j.refundAmountPaise),
    refundStatus: j.refundStatus || 'none',
    cashfreeRefundId: j.cashfreeRefundId,
    reviewPromptDismissed: !!j.reviewPromptDismissed,
    review: j.review ? { id: j.review.id, rating: j.review.rating, comment: j.review.comment, createdAt: j.review.createdAt } : null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
};

// POST /api/bookings/preview { itemType, itemId, scheduledFor?, scheduledEndAt?, guestCount?, walletPaise?, couponCode? }
// Pure read — no DB write. Returns the full pricing breakdown + item snapshot
// the frontend renders BEFORE the user commits to creating a booking.
const preview = asyncHandler(async (req, res) => {
  const itemType = normalizeType(req.body.itemType);
  const itemId = parseInt(req.body.itemId, 10);

  if (!ALLOWED_TYPES.includes(itemType)) return fail(res, 'Invalid item type', 400);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 'Invalid item id', 400);

  const item = await fetchItem(itemType, itemId);
  if (!item) return fail(res, 'Item not found or no longer available', 404);

  const schedule = resolveSchedule({
    item,
    scheduledFor: req.body.scheduledFor,
    scheduledEndAt: req.body.scheduledEndAt,
  });

  const guestCount = Math.max(1, parseInt(req.body.guestCount, 10) || 1);
  const roomCount = Math.max(1, parseInt(req.body.roomCount, 10) || 1);
  const extraPersons = parseExtraPersons(req.body.extraPersons);

  // First quote — no discounts — so we know the gross (subtotal + tax) and
  // can validate coupon min-order rules against it.
  const base = computePricing({ item, guestCount, units: schedule.units, roomCount, extraPersons, walletPaise: 0, couponDiscountPaise: 0 });

  // Coupon
  let couponResult = null;
  let couponDiscountPaise = 0;
  const couponCode = req.body.couponCode ? String(req.body.couponCode).trim().toUpperCase() : null;
  if (couponCode) {
    couponResult = await validateCouponFor({
      code: couponCode,
      user: req.user,
      subtotalPaise: base.subtotalPaise,
      taxPaise: base.taxPaise,
    });
    if (couponResult.ok) couponDiscountPaise = couponResult.discountPaise;
  }

  // Wallet — clamp to current balance, the order remainder after coupon,
  // AND the admin's anti-abuse cap (max per booking). The frontend can pass
  // useWallet=true ("use as much as the cap allows") or an explicit
  // useWalletPaise number ("up to N paise, still capped").
  const grossPaise = base.subtotalPaise + base.taxPaise;
  const userBalance = req.user.walletBalancePaise || 0;
  const refConfig = await loadReferralConfig();
  let walletPaise = 0;
  let walletCapPaise = 0;
  if (req.body.useWallet === true || req.body.useWalletPaise) {
    const remaining = Math.max(0, grossPaise - couponDiscountPaise);
    const requested = req.body.useWalletPaise
      ? Math.max(0, parseInt(req.body.useWalletPaise, 10) || 0)
      : userBalance;
    walletPaise = capWalletForBooking({
      requestedPaise: Math.min(requested, remaining),
      balancePaise: userBalance,
      grossPaise: remaining,
      config: refConfig,
    });
  }
  // Always report the cap so the UI can show "you can use up to X this booking".
  walletCapPaise = capWalletForBooking({
    requestedPaise: userBalance,
    balancePaise: userBalance,
    grossPaise: Math.max(0, grossPaise - couponDiscountPaise),
    config: refConfig,
  });

  const pricing = computePricing({
    item,
    guestCount,
    units: schedule.units,
    roomCount,
    extraPersons,
    walletPaise,
    couponDiscountPaise,
  });

  return ok(res, {
    item: buildItemSnapshot(item),
    schedule,
    guestCount,
    roomCount: pricing.roomsResolved,
    extraPersons,
    pricing,
    guest: {
      name: req.user.name || '',
      email: req.user.email,
      phone: req.user.phone || '',
    },
    walletAvailablePaise: userBalance,
    walletMaxThisBookingPaise: walletCapPaise,
    walletCapsApplied: {
      maxPerBookingPaise: refConfig.maxPerBookingPaise,
      maxPerBookingPct: refConfig.maxPerBookingPct,
    },
    coupon: couponResult ? {
      code: couponCode,
      ok: couponResult.ok,
      reason: couponResult.ok ? null : couponResult.reason,
      discountPaise: couponResult.ok ? couponResult.discountPaise : 0,
      description: couponResult.ok ? couponResult.description : null,
    } : null,
  });
});

// POST /api/bookings — persist a pending_payment row. Phase 5 promotes it to
// confirmed once Cashfree's webhook fires.
const create = asyncHandler(async (req, res) => {
  const itemType = normalizeType(req.body.itemType);
  const itemId = parseInt(req.body.itemId, 10);

  if (!ALLOWED_TYPES.includes(itemType)) return fail(res, 'Invalid item type', 400);
  if (!Number.isInteger(itemId) || itemId <= 0) return fail(res, 'Invalid item id', 400);

  const item = await fetchItem(itemType, itemId);
  if (!item) return fail(res, 'Item not found or no longer available', 404);

  const schedule = resolveSchedule({
    item,
    scheduledFor: req.body.scheduledFor,
    scheduledEndAt: req.body.scheduledEndAt,
  });

  // Strict validation: rooms must have a check-in AND check-out date; everything
  // else needs at least a scheduledFor. We bounce here so we don't write half
  // a booking row that the dashboard later renders as broken.
  if (itemType === 'room') {
    if (!schedule.scheduledFor || !schedule.scheduledEndAt) {
      return fail(res, 'Please choose check-in and check-out dates', 400);
    }
  } else if (!schedule.scheduledFor && itemType !== 'event') {
    return fail(res, 'Please choose a date', 400);
  }

  const guestCount = Math.max(1, parseInt(req.body.guestCount, 10) || 1);
  const roomCount = Math.max(1, parseInt(req.body.roomCount, 10) || 1);
  const extraPersons = parseExtraPersons(req.body.extraPersons);
  // Rooms auto-grow to fit the party (adults + extra guests) in computePricing,
  // so instead of rejecting an over-capacity request we just guard a sane upper
  // bound to avoid absurd room counts.
  if (itemType === 'room') {
    const maxOcc = Math.max(1, Number(item.meta?.maxOccupancy || 2));
    const needed = Math.ceil((guestCount + extraPersons.length) / maxOcc);
    if (needed > 20) {
      return fail(res, 'That party size needs too many rooms — please split the booking', 400);
    }
  }

  const guestName = String(req.body.guestName || req.user.name || '').trim();
  const guestEmail = String(req.body.guestEmail || req.user.email || '').trim().toLowerCase();
  const guestPhone = String(req.body.guestPhone || req.user.phone || '').trim();
  const specialRequests = req.body.specialRequests ? String(req.body.specialRequests).trim().slice(0, 1000) : null;

  if (!guestName) return fail(res, 'Guest name is required', 400);
  if (!guestPhone) return fail(res, 'Guest phone is required', 400);

  // ── Resolve coupon (if any) ────────────────────────────────────────────
  const base = computePricing({ item, guestCount, units: schedule.units, roomCount, extraPersons, walletPaise: 0, couponDiscountPaise: 0 });

  let couponObj = null;
  let couponDiscountPaise = 0;
  let couponCodeApplied = null;
  const requestedCoupon = req.body.couponCode ? String(req.body.couponCode).trim().toUpperCase() : null;
  if (requestedCoupon) {
    const result = await validateCouponFor({
      code: requestedCoupon,
      user: req.user,
      subtotalPaise: base.subtotalPaise,
      taxPaise: base.taxPaise,
    });
    if (!result.ok) return fail(res, result.reason, 400);
    couponObj = result.coupon;
    couponDiscountPaise = result.discountPaise;
    couponCodeApplied = result.coupon.code;
  }

  // ── Resolve wallet draw (if any) — same admin cap as the preview path.
  const gross = base.subtotalPaise + base.taxPaise;
  const userBalance = req.user.walletBalancePaise || 0;
  let walletPaise = 0;
  if (req.body.useWallet === true || req.body.useWalletPaise) {
    const refConfig = await loadReferralConfig();
    const remaining = Math.max(0, gross - couponDiscountPaise);
    const requested = req.body.useWalletPaise
      ? Math.max(0, parseInt(req.body.useWalletPaise, 10) || 0)
      : userBalance;
    walletPaise = capWalletForBooking({
      requestedPaise: Math.min(requested, remaining),
      balancePaise: userBalance,
      grossPaise: remaining,
      config: refConfig,
    });
  }

  const pricing = computePricing({
    item,
    guestCount,
    units: schedule.units,
    roomCount,
    extraPersons,
    walletPaise,
    couponDiscountPaise,
  });

  const bookingCode = await generateBookingCode();

  const booking = await Booking.create({
    bookingCode,
    userId: req.user.id,
    itemType,
    itemId,
    itemSnapshot: { ...buildItemSnapshot(item), extraPersons },
    scheduledFor: schedule.scheduledFor,
    scheduledEndAt: schedule.scheduledEndAt,
    scheduledAt: resolveScheduledAt(schedule.scheduledFor, specialRequests),
    units: schedule.units,
    guestName,
    guestEmail,
    guestPhone,
    guestCount,
    roomCount: itemType === 'room' ? pricing.roomsResolved : 1,
    specialRequests,
    currency: pricing.currency,
    unitPricePaise: pricing.unitPricePaise,
    subtotalPaise: pricing.subtotalPaise,
    gstPaise: pricing.gstPaise,
    tcsPaise: pricing.tcsPaise,
    taxPaise: pricing.taxPaise,
    walletDiscountPaise: pricing.walletDiscountPaise,
    couponDiscountPaise: pricing.couponDiscountPaise,
    couponCode: couponCodeApplied,
    totalPaise: pricing.totalPaise,
    status: 'pending_payment',
  });

  // ── Persist side-effects ──────────────────────────────────────────────
  // Wallet deduction happens immediately so the user sees the discounted
  // total reflect their reduced balance. If the booking is cancelled before
  // payment, refundWalletForBooking puts it back.
  if (pricing.walletDiscountPaise > 0) {
    try {
      await debitWalletForBooking({
        userId: req.user.id,
        amountPaise: pricing.walletDiscountPaise,
        bookingId: booking.id,
      });
    } catch (err) {
      // Roll back: nuke the booking so we don't leave a dangling row pointing
      // at an unreserved discount.
      await booking.destroy();
      return fail(res, err.message || 'Could not apply wallet credit', 400);
    }
  }

  if (couponObj) {
    await consumeCoupon({ coupon: couponObj });
  }

  return created(res, { booking: publicBooking(booking) }, 'Booking initialised');
});

// GET /api/bookings/me — list this user's bookings, newest first.
const listMine = asyncHandler(async (req, res) => {
  const { status, itemType } = req.query;
  const where = { userId: req.user.id };
  if (status) where.status = String(status);
  if (itemType) where.itemType = String(itemType);

  const rows = await Booking.findAll({
    where,
    include: [{ model: Review, as: 'review', attributes: ['id', 'rating', 'comment', 'createdAt'], required: false }],
    order: [['createdAt', 'DESC']],
    limit: Math.min(parseInt(req.query.limit, 10) || 100, 200),
  });

  return ok(res, { bookings: rows.map(publicBooking), count: rows.length });
});

// GET /api/bookings/me/:code — full detail for a single booking the user owns.
// Lookup by bookingCode (the public id), not the integer pk, so URLs are safe
// to share / save / paste.
const getMineByCode = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    where: { bookingCode: String(req.params.code), userId: req.user.id },
    include: [{ model: Review, as: 'review', attributes: ['id', 'rating', 'comment', 'createdAt'], required: false }],
  });
  if (!booking) return fail(res, 'Booking not found', 404);
  return ok(res, { booking: publicBooking(booking) });
});

// GET /api/bookings/me/:code/voucher.pdf — the same voucher attached to the
// confirmation email, downloadable on-demand from the app's booking detail
// screen (opened via Linking.openURL, hence the `?token=` middleware fallback).
const voucherPdf = asyncHandler(async (req, res) => {
  const { buildBookingVoucherPdf } = require('../services/bookingVoucherPdf.service');
  const booking = await Booking.findOne({
    where: { bookingCode: String(req.params.code), userId: req.user.id },
  });
  if (!booking) return fail(res, 'Booking not found', 404);

  const pdf = await buildBookingVoucherPdf(booking);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="voucher-${booking.bookingCode}.pdf"`);
  return res.send(pdf);
});

// Predefined cancellation reasons — kept in code (not config) so the user
// always sees the same options regardless of admin tinkering. The "other"
// option triggers the custom-reason text input in the UI.
const CANCEL_REASONS = [
  { code: 'plan_change',     label: 'My plan has changed' },
  { code: 'found_better',    label: 'Found a better option' },
  { code: 'price_high',      label: 'The price feels too high' },
  { code: 'payment_issue',   label: 'I had a payment issue' },
  { code: 'emergency',       label: 'Personal emergency / illness' },
  { code: 'travel_restrict', label: 'Travel restrictions / weather' },
  { code: 'wrong_dates',     label: 'Wrong dates booked by mistake' },
  { code: 'other',           label: 'Other (please specify)' },
];

// GET /api/bookings/me/:code/cancel-quote
// Returns the refund quote + policy so the user can preview "you'll get
// ₹X back, processed within 5-7 days" BEFORE confirming the cancellation.
const cancelQuote = asyncHandler(async (req, res) => {
  const { quoteForBooking } = require('../services/refund.service');
  const booking = await Booking.findOne({
    where: { bookingCode: String(req.params.code), userId: req.user.id },
  });
  if (!booking) return fail(res, 'Booking not found', 404);
  if (['cancelled', 'refunded', 'completed'].includes(booking.status)) {
    return fail(res, `Booking is already ${booking.status}`, 400);
  }

  const { policy, quote } = await quoteForBooking(booking);
  return ok(res, {
    bookingCode: booking.bookingCode,
    totalPaid: fromPaise(booking.totalPaise || 0),
    walletPortion: fromPaise(booking.walletDiscountPaise || 0),
    isPaid: !!booking.paidAt,
    policy: {
      source: policy.source,
      tiers: policy.tiers,
      enabled: policy.enabled,
      processingNote: policy.processingNote,
      isRefundable: policy.isRefundable !== false,
    },
    refund: quote,
    reasons: CANCEL_REASONS,
  });
});

// POST /api/bookings/me/:code/cancel  { reasonCode, reason }
// Real cancellation: applies the refund policy, hits Cashfree to push the
// money back to source, restores wallet + coupon, flips status.
const cancelMine = asyncHandler(async (req, res) => {
  const { quoteForBooking, executeRefund } = require('../services/refund.service');
  const booking = await Booking.findOne({
    where: { bookingCode: String(req.params.code), userId: req.user.id },
  });
  if (!booking) return fail(res, 'Booking not found', 404);
  if (['cancelled', 'refunded', 'completed'].includes(booking.status)) {
    return fail(res, `Booking is already ${booking.status}`, 400);
  }

  const reasonCode = String(req.body.reasonCode || 'other').trim().slice(0, 40);
  const reasonText = req.body.reason ? String(req.body.reason).slice(0, 250) : null;
  // Resolve the canonical label for storage so the admin UI can show
  // "Found a better option" not just "found_better".
  const known = CANCEL_REASONS.find((r) => r.code === reasonCode);
  const finalReason = reasonText || known?.label || null;

  // Compute the refund quote ONCE, then execute the side effects.
  const { quote } = await quoteForBooking(booking);

  booking.status = 'cancelled';
  booking.cancelledAt = new Date();
  booking.cancellationReason = finalReason;
  booking.cancellationReasonCode = reasonCode;
  // Set refundStatus to 'pending' optimistically — executeRefund will flip
  // to processing/completed/failed/none based on what actually happens.
  booking.refundStatus = 'pending';
  await booking.save();

  // Coupon usage restore — always, regardless of refund outcome.
  if (booking.couponCode) {
    restoreCoupon({ code: booking.couponCode })
      .catch((err) => console.error('[booking.cancel] coupon restore failed:', err.message));
  }

  let refundResult = { kind: 'none', refundStatus: 'none' };
  if (booking.paidAt && quote.refundAmountPaise > 0) {
    refundResult = await executeRefund({ booking, quote, reason: finalReason });
  } else if (!booking.paidAt) {
    // Never-paid booking → no money to return, but still restore wallet
    // portion (in case the user partially applied wallet before payment).
    if (booking.walletDiscountPaise > 0) {
      refundWalletForBooking({
        userId: booking.userId,
        amountPaise: booking.walletDiscountPaise,
        bookingId: booking.id,
      }).catch((err) => console.error('[booking.cancel] wallet refund failed:', err.message));
    }
    booking.refundStatus = 'none';
    await booking.save();
  } else {
    // Paid but 0% refund tier → reset status to 'none' so the UI doesn't
    // mis-show a pending refund spinner forever.
    booking.refundStatus = 'none';
    await booking.save();
  }

  // Refresh the booking from DB so the response carries the latest refund
  // state (executeRefund saved it inside).
  await booking.reload();

  return ok(res, {
    booking: publicBooking(booking),
    refund: { ...quote, result: refundResult },
  }, 'Booking cancelled');
});

module.exports = {
  preview,
  create,
  listMine,
  getMineByCode,
  voucherPdf,
  cancelMine,
  cancelQuote,
  CANCEL_REASONS,
  publicBooking,
};

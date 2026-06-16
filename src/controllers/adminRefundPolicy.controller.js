const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { RefundPolicy, Booking } = require('../models');
const { ok, fail } = require('../utils/response');
const { fromPaise } = require('../services/booking.service');
const { HARD_DEFAULT, reconcileRefundStatus } = require('../services/refund.service');

const ensureRow = async () => {
  let row = await RefundPolicy.findByPk(1);
  if (!row) {
    row = await RefundPolicy.create({
      id: 1,
      tiers: HARD_DEFAULT.tiers,
      enabled: HARD_DEFAULT.enabled,
      processingNote: HARD_DEFAULT.processingNote,
    });
  }
  return row;
};

const publicPolicy = (row) => ({
  id: row.id,
  enabled: !!row.enabled,
  tiers: row.tiers || [],
  processingNote: row.processingNote,
  updatedAt: row.updatedAt,
});

// GET /api/admin/refund-policy
const get = asyncHandler(async (req, res) => {
  const row = await ensureRow();

  // Lifetime refund stats — show admin how much money has actually flowed
  // back out via this policy (filtered to refunded/cancelled bookings).
  const stats = await Booking.findOne({
    where: {
      refundStatus: { [Op.in]: ['processing', 'completed', 'pending'] },
    },
    attributes: [
      [Booking.sequelize.fn('COUNT', Booking.sequelize.col('id')), 'count'],
      [Booking.sequelize.fn('SUM', Booking.sequelize.col('refundAmountPaise')), 'totalPaise'],
    ],
    raw: true,
  });
  const failedCount = await Booking.count({ where: { refundStatus: 'failed' } });

  return ok(res, {
    policy: publicPolicy(row),
    defaults: HARD_DEFAULT,
    stats: {
      totalRefunds: Number(stats?.count || 0),
      totalRefundAmount: fromPaise(Number(stats?.totalPaise || 0)),
      failedCount,
    },
  });
});

// PUT /api/admin/refund-policy { enabled, tiers, processingNote }
const update = asyncHandler(async (req, res) => {
  const row = await ensureRow();
  const body = req.body || {};

  if (typeof body.enabled === 'boolean') row.enabled = body.enabled;
  if (body.processingNote !== undefined) {
    row.processingNote = String(body.processingNote || '').slice(0, 500);
  }

  if (Array.isArray(body.tiers)) {
    const cleaned = [];
    for (const t of body.tiers) {
      if (!t || typeof t !== 'object') continue;
      const hours = parseInt(t.hoursBeforeCheckIn, 10);
      const pct   = Number(t.refundPercent);
      if (!Number.isFinite(hours) || hours < 0) continue;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
      cleaned.push({
        hoursBeforeCheckIn: hours,
        refundPercent: Math.round(pct * 100) / 100,
        label: String(t.label || `${hours}+ hours before check-in`).slice(0, 120),
      });
    }
    if (!cleaned.length) {
      return fail(res, 'At least one valid tier is required', 400);
    }
    // Always make sure there's a 0-hour bucket so we never have a "what to
    // do?" gap when someone cancels at the last minute.
    if (!cleaned.some((t) => t.hoursBeforeCheckIn === 0)) {
      cleaned.push({ hoursBeforeCheckIn: 0, refundPercent: 0, label: 'Within 24 hours of check-in' });
    }
    row.tiers = cleaned;
  }

  await row.save();
  return ok(res, { policy: publicPolicy(row) }, 'Refund policy updated');
});

// POST /api/admin/refund-policy/reset
const reset = asyncHandler(async (req, res) => {
  const [row] = await RefundPolicy.upsert({
    id: 1,
    tiers: HARD_DEFAULT.tiers,
    enabled: HARD_DEFAULT.enabled,
    processingNote: HARD_DEFAULT.processingNote,
  });
  return ok(res, { policy: publicPolicy(row) }, 'Refund policy reset to defaults');
});

// POST /api/admin/refund-policy/reconcile/:bookingCode — ping Cashfree for the
// latest status of a stuck refund and update our booking row accordingly.
// Useful for the admin "Refresh" button in the bookings detail modal.
const reconcile = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({ where: { bookingCode: String(req.params.bookingCode) } });
  if (!booking) return fail(res, 'Booking not found', 404);
  const result = await reconcileRefundStatus({ booking });
  if (!result) return fail(res, 'Nothing to reconcile (no refund in flight or Cashfree not configured)', 400);
  return ok(res, {
    bookingCode: booking.bookingCode,
    refundStatus: booking.refundStatus,
    raw: result.raw,
  }, 'Refund status refreshed');
});

module.exports = { get, update, reset, reconcile };

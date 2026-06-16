const asyncHandler = require('express-async-handler');
const { ReferralConfig, WalletTransaction, User, Booking } = require('../models');
const { ok, fail } = require('../utils/response');
const { fromPaise } = require('../services/booking.service');
const { getDefaultConfig } = require('../services/referEarn.service');

// Single-row config — we always operate on id=1. First read creates it from
// the service's hard-coded defaults so the admin UI never sees a missing row.
const ensureRow = async () => {
  let row = await ReferralConfig.findByPk(1);
  if (!row) {
    const def = getDefaultConfig();
    row = await ReferralConfig.create({
      id: 1,
      baseAmountPaise: def.baseAmountPaise,
      tiers: def.tiers,
      enabled: def.enabled,
      maxPerBookingPaise: def.maxPerBookingPaise,
      maxPerBookingPct: def.maxPerBookingPct,
      redemptionTiers: def.redemptionTiers || [],
    });
  }
  return row;
};

const publicConfig = (row) => ({
  id: row.id,
  enabled: !!row.enabled,
  baseAmount: fromPaise(row.baseAmountPaise || 0),
  baseAmountPaise: row.baseAmountPaise || 0,
  tiers: (row.tiers || []).map((t) => ({
    atCount: t.atCount,
    withinDays: t.withinDays,
    totalPayout: fromPaise(t.totalPayoutPaise || 0),
    totalPayoutPaise: t.totalPayoutPaise || 0,
    label: t.label || `${t.atCount} referrals within ${t.withinDays} days`,
  })),
  // Anti-abuse caps on per-booking wallet usage. 0 means "no cap" for that knob.
  maxPerBooking: fromPaise(row.maxPerBookingPaise || 0),
  maxPerBookingPaise: row.maxPerBookingPaise || 0,
  maxPerBookingPct: row.maxPerBookingPct || 0,
  // Booking-range tiers — exposed in both rupee + paise shapes so the UI
  // can render numbers without divisions and the backend still has the
  // canonical paise value when the admin saves.
  redemptionTiers: (row.redemptionTiers || []).map((t) => ({
    min: fromPaise(t.minPaise || 0),
    max: t.maxPaise === null || t.maxPaise === undefined ? null : fromPaise(t.maxPaise),
    cap: fromPaise(t.capPaise || 0),
    capPct: t.capPct || 0,
    minPaise: t.minPaise || 0,
    maxPaise: t.maxPaise === null || t.maxPaise === undefined ? null : t.maxPaise,
    capPaise: t.capPaise || 0,
    label: t.label || formatTierLabel(t),
  })),
  description: row.description,
  updatedAt: row.updatedAt,
});

const formatTierLabel = (t) => {
  const min = fromPaise(t.minPaise || 0);
  const max = t.maxPaise === null || t.maxPaise === undefined ? null : fromPaise(t.maxPaise);
  const cap = fromPaise(t.capPaise || 0);
  const range = max === null
    ? `Above ₹${min.toLocaleString()}`
    : `₹${min.toLocaleString()}–₹${max.toLocaleString()}`;
  const capStr = cap > 0
    ? `up to ₹${cap.toLocaleString()}${t.capPct > 0 ? ` or ${t.capPct}%` : ''}`
    : t.capPct > 0 ? `up to ${t.capPct}%` : 'no extra cap';
  return `${range} → ${capStr}`;
};

// GET /api/admin/referral-config
const get = asyncHandler(async (req, res) => {
  const row = await ensureRow();

  // Lifetime referral payout stats — useful sanity-check banner on the admin
  // UI ("we have paid out ₹X across Y referrals to date"). Cheap aggregate.
  const stats = await WalletTransaction.findOne({
    where: { type: 'referral_payout' },
    attributes: [
      [WalletTransaction.sequelize.fn('COUNT', WalletTransaction.sequelize.col('id')), 'count'],
      [WalletTransaction.sequelize.fn('SUM', WalletTransaction.sequelize.col('amountPaise')), 'totalPaise'],
    ],
    raw: true,
  });

  return ok(res, {
    config: publicConfig(row),
    defaults: {
      ...getDefaultConfig(),
      baseAmount: fromPaise(getDefaultConfig().baseAmountPaise),
    },
    stats: {
      totalPayouts: Number(stats?.count || 0),
      totalAmount: fromPaise(Number(stats?.totalPaise || 0)),
    },
  });
});

// PUT /api/admin/referral-config { enabled, baseAmount, tiers[], description }
// `baseAmount` and tier amounts arrive as rupees (decimal) — we convert to
// paise for storage so the math stays integer-only at runtime.
const update = asyncHandler(async (req, res) => {
  const row = await ensureRow();

  const body = req.body || {};

  if (typeof body.enabled === 'boolean') row.enabled = body.enabled;

  if (body.baseAmount !== undefined) {
    const rupees = Number(body.baseAmount);
    if (!Number.isFinite(rupees) || rupees < 0) {
      return fail(res, 'baseAmount must be a non-negative number (₹)', 400);
    }
    row.baseAmountPaise = Math.round(rupees * 100);
  }

  if (Array.isArray(body.tiers)) {
    const cleaned = [];
    for (const t of body.tiers) {
      if (!t || typeof t !== 'object') continue;
      const atCount = parseInt(t.atCount, 10);
      const withinDays = parseInt(t.withinDays, 10);
      const totalPayout = Number(t.totalPayout);
      if (!Number.isFinite(atCount) || atCount < 1) continue;
      if (!Number.isFinite(withinDays) || withinDays < 0) continue;
      if (!Number.isFinite(totalPayout) || totalPayout < 0) continue;
      cleaned.push({
        atCount,
        withinDays,
        totalPayoutPaise: Math.round(totalPayout * 100),
        label: String(t.label || `${atCount} referrals within ${withinDays} days`).slice(0, 120),
      });
    }
    // Reject obvious mistakes early — same atCount twice would silently
    // collide on first-match wins.
    const seen = new Set();
    for (const t of cleaned) {
      const key = `${t.atCount}:${t.withinDays}`;
      if (seen.has(key)) {
        return fail(res, `Duplicate tier with atCount=${t.atCount} and withinDays=${t.withinDays}`, 400);
      }
      seen.add(key);
    }
    row.tiers = cleaned;
  }

  if (body.description !== undefined) {
    row.description = String(body.description || '').slice(0, 500);
  }

  if (body.maxPerBooking !== undefined) {
    const rupees = Number(body.maxPerBooking);
    if (!Number.isFinite(rupees) || rupees < 0) {
      return fail(res, 'maxPerBooking must be a non-negative number (₹). Use 0 to disable.', 400);
    }
    row.maxPerBookingPaise = Math.round(rupees * 100);
  }
  if (body.maxPerBookingPct !== undefined) {
    const pct = parseInt(body.maxPerBookingPct, 10);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return fail(res, 'maxPerBookingPct must be 0–100. Use 0 to disable.', 400);
    }
    row.maxPerBookingPct = pct;
  }

  if (Array.isArray(body.redemptionTiers)) {
    const cleaned = [];
    for (const t of body.redemptionTiers) {
      if (!t || typeof t !== 'object') continue;
      const min = Number(t.min);
      const maxRaw = t.max;
      const cap = Number(t.cap);
      const capPct = parseInt(t.capPct, 10);

      if (!Number.isFinite(min) || min < 0) continue;
      const max = maxRaw === null || maxRaw === undefined || maxRaw === ''
        ? null
        : Number(maxRaw);
      if (max !== null && (!Number.isFinite(max) || max < min)) {
        return fail(res, `Tier max (₹${maxRaw}) must be ≥ min (₹${min}). Leave blank for open-ended.`, 400);
      }
      if (!Number.isFinite(cap) || cap < 0) continue;
      if (!Number.isFinite(capPct) || capPct < 0 || capPct > 100) {
        return fail(res, 'Tier % cap must be 0–100. Use 0 to disable.', 400);
      }

      cleaned.push({
        minPaise: Math.round(min * 100),
        maxPaise: max === null ? null : Math.round(max * 100),
        capPaise: Math.round(cap * 100),
        capPct,
        label: String(t.label || '').slice(0, 120),
      });
    }
    // Sort by min ascending so the matcher's first-match-wins ordering
    // is intuitive.
    cleaned.sort((a, b) => a.minPaise - b.minPaise);
    row.redemptionTiers = cleaned;
  }

  await row.save();
  return ok(res, { config: publicConfig(row) }, 'Referral config updated');
});

// POST /api/admin/referral-config/reset — restore the hard-coded defaults
// so an admin can recover from an experimental edit gone wrong.
const reset = asyncHandler(async (req, res) => {
  const def = getDefaultConfig();
  const [row] = await ReferralConfig.upsert({
    id: 1,
    baseAmountPaise: def.baseAmountPaise,
    tiers: def.tiers,
    enabled: def.enabled,
    maxPerBookingPaise: def.maxPerBookingPaise,
    maxPerBookingPct: def.maxPerBookingPct,
    redemptionTiers: def.redemptionTiers || [],
    description: 'Earn ₹300 each time a friend joins using your code. Get 3 friends to join within 10 days and earn ₹1,200 instead of ₹900.',
  });
  return ok(res, { config: publicConfig(row) }, 'Referral config reset to defaults');
});

module.exports = { get, update, reset };

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { User, Coupon, WalletTransaction, Booking } = require('../models');
const { ok, fail } = require('../utils/response');
const { fromPaise } = require('../services/booking.service');
const { loadConfig, validateCouponFor } = require('../services/referEarn.service');

const publicCoupon = (c) => {
  if (!c) return null;
  const j = c.toJSON ? c.toJSON() : c;
  return {
    id: j.id,
    code: j.code,
    kind: j.kind,
    value: j.value,
    maxDiscount: j.maxDiscountPaise ? fromPaise(j.maxDiscountPaise) : null,
    minOrder: j.minOrderPaise ? fromPaise(j.minOrderPaise) : 0,
    usageLimit: j.usageLimit,
    timesUsed: j.timesUsed,
    expiresAt: j.expiresAt,
    reason: j.reason,
    description: j.description,
    isActive: j.isActive,
    isExpired: j.expiresAt ? new Date(j.expiresAt) < new Date() : false,
    isUsedUp: j.usageLimit ? j.timesUsed >= j.usageLimit : false,
  };
};

const publicTransaction = (t) => {
  if (!t) return null;
  const j = t.toJSON ? t.toJSON() : t;
  return {
    id: j.id,
    type: j.type,
    amount: fromPaise(j.amountPaise),
    amountPaise: j.amountPaise,
    balanceAfter: fromPaise(j.balanceAfterPaise),
    description: j.description,
    referenceType: j.referenceType,
    referenceId: j.referenceId,
    createdAt: j.createdAt,
  };
};

// GET /api/refer-earn/wallet
const getWallet = asyncHandler(async (req, res) => {
  const user = req.user;
  const txns = await WalletTransaction.findAll({
    where: { userId: user.id },
    order: [['createdAt', 'DESC']],
    limit: 50,
  });
  return ok(res, {
    balance: fromPaise(user.walletBalancePaise || 0),
    balancePaise: user.walletBalancePaise || 0,
    transactions: txns.map(publicTransaction),
  });
});

// GET /api/refer-earn/coupons
const listCoupons = asyncHandler(async (req, res) => {
  // Personal coupons only — public ones aren't listed here, the user has to
  // know the code (e.g. from a marketing email).
  const rows = await Coupon.findAll({
    where: { userId: req.user.id, isActive: true },
    order: [['createdAt', 'DESC']],
  });
  const coupons = rows.map(publicCoupon);
  return ok(res, {
    coupons,
    active: coupons.filter((c) => !c.isExpired && !c.isUsedUp).length,
    used: coupons.filter((c) => c.isUsedUp).length,
    expired: coupons.filter((c) => c.isExpired && !c.isUsedUp).length,
  });
});

// GET /api/refer-earn/referees — the users I referred, plus their booking state.
const listReferees = asyncHandler(async (req, res) => {
  const referees = await User.findAll({
    where: { referredByUserId: req.user.id },
    attributes: ['id', 'name', 'email', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });

  // For each referee, count their paid bookings. One query for everyone
  // (group by userId) keeps this lean even for power referrers.
  const ids = referees.map((r) => r.id);
  let paidByUser = {};
  if (ids.length > 0) {
    const rows = await Booking.findAll({
      where: {
        userId: { [Op.in]: ids },
        status: { [Op.in]: ['confirmed', 'completed'] },
      },
      attributes: ['userId'],
    });
    for (const r of rows) {
      paidByUser[r.userId] = (paidByUser[r.userId] || 0) + 1;
    }
  }

  // v2 consolidated referral payouts use referenceId="payout:<refereeUserId>"
  // (a single row per referee that includes any tier bonus). Legacy data may
  // also have "base:<refereeUserId>" + "tier:N:D:<anchor>" pairs from before
  // the consolidation rewrite — we sum both shapes so older test data still
  // renders correctly.
  const payouts = await WalletTransaction.findAll({
    where: { userId: req.user.id, type: 'referral_payout', referenceType: 'referral' },
    attributes: ['referenceId', 'amountPaise', 'createdAt'],
  });
  const payoutByUser = {};
  for (const p of payouts) {
    const ref = String(p.referenceId || '');
    let uid = null;
    if (ref.startsWith('payout:')) uid = parseInt(ref.slice(7), 10);
    else if (ref.startsWith('base:')) uid = parseInt(ref.slice(5), 10);
    // tier:N:D:<anchor> rows go to the anchor referee but we no longer
    // surface them separately — they're folded into the anchor's payout above.
    else if (ref.startsWith('tier:')) {
      const parts = ref.split(':');
      uid = parseInt(parts[3], 10);
    }
    if (!uid) continue;
    // If multiple rows reference the same user (legacy: base + tier anchor),
    // sum the amounts so the UI shows the total reward per referee.
    if (payoutByUser[uid]) {
      payoutByUser[uid] = {
        ...payoutByUser[uid],
        amountPaise: (payoutByUser[uid].amountPaise || 0) + (p.amountPaise || 0),
        createdAt: p.createdAt > payoutByUser[uid].createdAt ? p.createdAt : payoutByUser[uid].createdAt,
      };
    } else {
      payoutByUser[uid] = { referenceId: ref, amountPaise: p.amountPaise, createdAt: p.createdAt };
    }
  }

  const data = referees.map((r) => {
    const j = r.toJSON();
    const paid = paidByUser[r.id] || 0;
    const payout = payoutByUser[r.id] || null;
    return {
      id: j.id,
      name: j.name,
      // Mask the email lightly — referees shouldn't be doxxed if a referrer
      // shares a screenshot. First 2 chars + *** + domain.
      emailMasked: maskEmail(j.email),
      joinedAt: j.createdAt,
      paidBookingCount: paid,
      rewardEarned: payout ? fromPaise(payout.amountPaise) : 0,
      rewardEarnedAt: payout ? payout.createdAt : null,
      status: paid > 0 ? 'rewarded' : 'pending',
    };
  });

  const totalEarned = data.reduce((acc, r) => acc + (r.rewardEarned || 0), 0);

  return ok(res, {
    referees: data,
    count: data.length,
    rewardedCount: data.filter((r) => r.status === 'rewarded').length,
    pendingCount: data.filter((r) => r.status === 'pending').length,
    totalEarned,
  });
});

const maskEmail = (email) => {
  if (!email) return '—';
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};

// GET /api/refer-earn/config — return the public-facing reward amounts so
// the frontend can render "Earn ₹300 per friend" + the tier bonuses without
// hardcoding them. Reads the admin-configurable singleton so an edit in the
// dashboard reflects immediately.
const getConfig = asyncHandler(async (req, res) => {
  const cfg = await loadConfig();
  return ok(res, {
    enabled: cfg.enabled,
    baseAmount: fromPaise(cfg.baseAmountPaise),
    tiers: (cfg.tiers || []).map((t) => ({
      atCount: t.atCount,
      withinDays: t.withinDays,
      totalPayout: fromPaise(t.totalPayoutPaise || 0),
      label: t.label,
    })),
  });
});

// POST /api/refer-earn/validate-coupon { code, subtotalPaise, taxPaise }
// Used by the booking preview page to show "Coupon valid! ₹X off" as the
// user types — without committing the coupon yet.
const validateCoupon = asyncHandler(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const subtotalPaise = Math.max(0, parseInt(req.body.subtotalPaise, 10) || 0);
  const taxPaise = Math.max(0, parseInt(req.body.taxPaise, 10) || 0);

  const result = await validateCouponFor({ code, user: req.user, subtotalPaise, taxPaise });
  if (!result.ok) return fail(res, result.reason, 400);

  return ok(res, {
    code,
    discount: fromPaise(result.discountPaise),
    discountPaise: result.discountPaise,
    description: result.description,
  }, 'Coupon valid');
});

module.exports = {
  getWallet,
  listCoupons,
  listReferees,
  getConfig,
  validateCoupon,
};

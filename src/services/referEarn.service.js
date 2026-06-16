const crypto = require('crypto');
const { Op } = require('sequelize');
const { User, Coupon, WalletTransaction, Booking, ReferralConfig, sequelize } = require('../models');

// ─── Config loading ───────────────────────────────────────────────────────
// All amounts in paise. We read the singleton ReferralConfig row each time
// the service is called so admin edits take effect immediately (no restart).
// Falls back to hard-coded defaults if the row hasn't been seeded yet.

const DEFAULT_CONFIG = {
  baseAmountPaise: 30000,            // ₹300 per qualifying referral
  tiers: [
    { atCount: 3, withinDays: 10, totalPayoutPaise: 120000, label: '3 referrals within 10 days' },
  ],
  enabled: true,
  maxPerBookingPaise: 50000,         // ₹500 cap by default
  maxPerBookingPct: 25,              // 25% of gross by default
  redemptionTiers: [],               // empty = fall back to global knobs
};

const loadConfig = async () => {
  try {
    const row = await ReferralConfig.findByPk(1);
    if (!row) return DEFAULT_CONFIG;
    return {
      baseAmountPaise: Math.max(0, parseInt(row.baseAmountPaise, 10) || 0),
      tiers: Array.isArray(row.tiers) ? row.tiers : DEFAULT_CONFIG.tiers,
      enabled: row.enabled !== false,
      maxPerBookingPaise: Math.max(0, parseInt(row.maxPerBookingPaise, 10) || 0),
      maxPerBookingPct: Math.max(0, Math.min(100, parseInt(row.maxPerBookingPct, 10) || 0)),
      redemptionTiers: Array.isArray(row.redemptionTiers) ? row.redemptionTiers : [],
    };
  } catch {
    return DEFAULT_CONFIG;
  }
};

// Find the redemption tier (from the admin-defined ranges) that contains
// `grossPaise`. Returns `null` when none matches — caller falls back to
// the global cap.
const findRedemptionTier = (grossPaise, tiers) => {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const g = Math.max(0, Number(grossPaise || 0));
  for (const t of tiers) {
    if (!t) continue;
    const min = Math.max(0, Number(t.minPaise || 0));
    const max = t.maxPaise === null || t.maxPaise === undefined || t.maxPaise === ''
      ? Infinity
      : Math.max(min, Number(t.maxPaise));
    if (g >= min && g <= max) return t;
  }
  return null;
};

// Compute how much of a user's wallet balance they're allowed to redeem
// against a single booking. Returns the lesser of:
//   - actual balance
//   - matched redemption tier's caps (if any tier matches the gross)
//   - OR the global caps when no tier matches
//   - amount that would zero out the order (no negative totals)
// 0 from a cap field means "no cap" for that knob.
const capWalletForBooking = ({ requestedPaise, balancePaise, grossPaise, config }) => {
  let cap = Math.max(0, Number(requestedPaise || 0));
  cap = Math.min(cap, Math.max(0, Number(balancePaise || 0)));
  cap = Math.min(cap, Math.max(0, Number(grossPaise || 0)));

  // 1) If a tier matches the booking amount, use its knobs first.
  const tier = findRedemptionTier(grossPaise, config?.redemptionTiers);
  if (tier) {
    if (Number(tier.capPaise) > 0) {
      cap = Math.min(cap, Number(tier.capPaise));
    }
    if (Number(tier.capPct) > 0) {
      const pctCap = Math.floor((Number(grossPaise || 0) * Number(tier.capPct)) / 100);
      cap = Math.min(cap, pctCap);
    }
    return cap;
  }

  // 2) No matching tier — fall through to the global caps.
  if (config?.maxPerBookingPaise > 0) {
    cap = Math.min(cap, config.maxPerBookingPaise);
  }
  if (config?.maxPerBookingPct > 0) {
    const pctCap = Math.floor((Number(grossPaise || 0) * config.maxPerBookingPct) / 100);
    cap = Math.min(cap, pctCap);
  }
  return cap;
};

// Public helper so the admin UI can render the same defaults if the row
// doesn't exist yet. Kept on the service so there's one source of truth.
const getDefaultConfig = () => DEFAULT_CONFIG;

// ─── Coupon helpers ───────────────────────────────────────────────────────
// We keep generateCouponCode + validate/consume/restore exported because the
// rest of the booking flow uses them. Referral-coupon issuance was removed
// in the v2 referral rewrite (only the referrer earns money now).

const generateCouponCode = async (prefix = 'CODE') => {
  for (let i = 0; i < 6; i++) {
    const tail = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `${prefix}-${tail}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await Coupon.findOne({ where: { code }, attributes: ['id'] });
    if (!exists) return code;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
};

// ─── Referral payout (v2) ─────────────────────────────────────────────────
// New rules (May 2026):
//   • ONLY the referrer earns. The referee gets nothing extra.
//   • Payout fires when the referee's FIRST paid booking is confirmed.
//   • Flat baseAmountPaise (default ₹300) per qualifying referral, UNLESS a
//     tier bonus kicks in.
//   • Tier example (default): { atCount: 3, withinDays: 10, totalPayoutPaise: 120000 }
//     — when the referrer's Nth qualifying referee (N=atCount) completes their
//     first paid booking AND all N referees did so within `withinDays` of the
//     FIRST qualifying referee's first-paid date, the tier pays out a single
//     "top-up" credit so the referrer's total for those N referees equals
//     totalPayoutPaise (i.e. tier - already-paid base × N).
//   • Multiple tiers allowed — first one that matches wins.

// Find every other referee of this referrer whose first paid booking has
// already cleared, ordered by that "first paid" timestamp. Used to compute
// `currentCount` and the start of the bonus window.
const fetchPriorQualifiedReferees = async (referrerId, excludingRefereeId) => {
  const referees = await User.findAll({
    where: { referredByUserId: referrerId, id: { [Op.ne]: excludingRefereeId } },
    attributes: ['id'],
    raw: true,
  });
  if (!referees.length) return [];

  // For each referee, find their earliest paid booking. We only count those
  // who have one. Done in one IN-query so this stays O(referees).
  const firstPaid = await Booking.findAll({
    where: {
      userId: { [Op.in]: referees.map((r) => r.id) },
      status: { [Op.in]: ['confirmed', 'completed'] },
      paidAt: { [Op.ne]: null },
    },
    attributes: ['userId', [sequelize.fn('MIN', sequelize.col('paidAt')), 'firstPaidAt']],
    group: ['userId'],
    raw: true,
  });

  return firstPaid
    .filter((r) => r.firstPaidAt)
    .map((r) => ({ refereeId: r.userId, firstPaidAt: new Date(r.firstPaidAt) }))
    .sort((a, b) => a.firstPaidAt - b.firstPaidAt);
};

// Pick the highest-rank tier the referrer is currently eligible for, given
// the count of qualifying referees (including the one that just paid) and
// the dates of all qualifying referees ordered chronologically.
const evaluateTier = (tiers, qualifyingDates) => {
  const count = qualifyingDates.length;
  if (count === 0) return null;
  const firstAt = qualifyingDates[0];
  const latestAt = qualifyingDates[qualifyingDates.length - 1];

  // Match the tier whose atCount equals this referral count AND whose
  // withinDays window from `firstAt` still contains `latestAt`.
  for (const tier of tiers) {
    if (!tier || typeof tier.atCount !== 'number') continue;
    if (count !== tier.atCount) continue;
    const windowMs = (tier.withinDays || 0) * 24 * 60 * 60 * 1000;
    if (windowMs > 0 && latestAt - firstAt > windowMs) continue;
    return tier;
  }
  return null;
};

// Atomic credit helper. Locks the user row, bumps the balance, writes the
// ledger row, returns the new balance. All other referral writes go through
// this so the wallet never observes a partial state.
const creditReferrerWallet = async ({ referrerId, amountPaise, refereeId, bookingId, kind, label }) => {
  if (!amountPaise || amountPaise <= 0) return null;
  return sequelize.transaction(async (tx) => {
    const fresh = await User.findByPk(referrerId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!fresh) return null;
    const newBalance = (fresh.walletBalancePaise || 0) + amountPaise;
    fresh.walletBalancePaise = newBalance;
    await fresh.save({ transaction: tx });

    await WalletTransaction.create({
      userId: fresh.id,
      amountPaise,
      balanceAfterPaise: newBalance,
      type: 'referral_payout',
      // We pair (kind, refereeId) into referenceId so the same referee can
      // trigger BOTH a base payout AND (later) a tier top-up without colliding
      // on the idempotency guard.
      referenceType: 'referral',
      referenceId: `${kind}:${refereeId}`,
      description: label,
    }, { transaction: tx });

    return { newBalance, amountPaise };
  });
};

// v3 trigger: payout fires the moment the referee completes their profile
// (i.e. first login as a real account, with name + phone). Rules are the
// same as the v2 first-paid logic — flat base unless a tier matches — but
// the "qualifying date" comes from the referee row itself, not from any
// booking.
const creditReferrerForFirstLogin = async ({ user }) => {
  if (!user || !user.id || !user.referredByUserId) return null;
  const referrer = await User.findByPk(user.referredByUserId);
  if (!referrer || !referrer.isActive) return null;

  const config = await loadConfig();
  if (!config.enabled) return null;

  // Idempotency — same key the v2 path uses, so an upgrade from v2 to v3
  // never double-pays a referee that already triggered a base/tier payout.
  const already = await WalletTransaction.findOne({
    where: {
      type: 'referral_payout',
      referenceType: 'referral',
      referenceId: { [Op.in]: [`payout:${user.id}`, `base:${user.id}`] },
    },
    attributes: ['id'],
  });
  if (already) return null;

  // Use the referee's profile-completion moment as the qualifying date.
  const qualifyingAt = user.updatedAt || new Date();

  // For tier evaluation we need other previously-qualified referees of
  // the same referrer. We approximate "qualified" by "has a non-null
  // referredByUserId === referrer.id AND already has a payout row". That
  // gives us every referee who has already cleared this same gate.
  const otherReferees = await User.findAll({
    where: { referredByUserId: referrer.id, id: { [Op.ne]: user.id } },
    attributes: ['id', 'updatedAt'],
    raw: true,
  });
  const otherIds = otherReferees.map((r) => r.id);
  let priorDates = [];
  if (otherIds.length) {
    const paid = await WalletTransaction.findAll({
      where: {
        type: 'referral_payout',
        referenceType: 'referral',
        referenceId: { [Op.in]: otherIds.map((id) => `payout:${id}`) },
      },
      attributes: ['referenceId', 'createdAt'],
      raw: true,
    });
    priorDates = paid
      .map((p) => new Date(p.createdAt))
      .sort((a, b) => a - b);
  }
  const allQualifying = [...priorDates, qualifyingAt].sort((a, b) => a - b);
  const matchedTier = evaluateTier(config.tiers || [], allQualifying);

  let tierFirstHit = false;
  if (matchedTier) {
    const tierKey = `tier:${matchedTier.atCount}:${matchedTier.withinDays}`;
    const tierPaidBefore = await WalletTransaction.findOne({
      where: {
        type: 'referral_payout',
        referenceType: 'referral',
        referenceId: { [Op.like]: `${tierKey}:%` },
      },
      attributes: ['id'],
    });
    tierFirstHit = !tierPaidBefore;
  }

  let amountPaise;
  let label;
  if (matchedTier && tierFirstHit) {
    const earlierBaseTotal = config.baseAmountPaise * (matchedTier.atCount - 1);
    amountPaise = Math.max(config.baseAmountPaise, matchedTier.totalPayoutPaise - earlierBaseTotal);
    label = `Referral reward — ${user.email} joined · ${matchedTier.label || `${matchedTier.atCount}-in-${matchedTier.withinDays}-day bonus`}`;
  } else {
    amountPaise = config.baseAmountPaise;
    label = `Referral reward — ${user.email} joined`;
  }
  if (amountPaise <= 0) return null;

  const credit = await creditReferrerWallet({
    referrerId: referrer.id,
    amountPaise,
    refereeId: user.id,
    bookingId: 0,
    kind: 'payout',
    label,
  });
  return credit ? [credit] : null;
};

// Legacy v2 trigger — still callable from the payment webhook as a safety
// net in case the first-login path was skipped for an older referee. Both
// paths share the same idempotency key (`payout:<refereeId>`) so the
// referee can never receive a double payout.
const creditReferrerForFirstPaid = async ({ booking }) => {
  if (!booking || !booking.userId) return null;
  if (booking.status !== 'confirmed' && booking.status !== 'completed') return null;

  const referee = await User.findByPk(booking.userId);
  if (!referee || !referee.referredByUserId) return null;

  const referrer = await User.findByPk(referee.referredByUserId);
  if (!referrer || !referrer.isActive) return null;

  const config = await loadConfig();
  if (!config.enabled) return null;

  // Is this actually the FIRST paid booking for this referee? Check for any
  // OTHER confirmed/completed booking on the same user.
  const earlierPaid = await Booking.findOne({
    where: {
      userId: referee.id,
      status: { [Op.in]: ['confirmed', 'completed'] },
      id: { [Op.ne]: booking.id },
      paidAt: { [Op.ne]: null },
    },
    attributes: ['id'],
  });
  if (earlierPaid) return null;

  // Idempotency: have we ALREADY paid out for this referee? In v2 we use a
  // single `payout:<refereeId>` key per referee, which covers both the flat
  // base payout AND any tier-triggered larger payout. So one referee = one
  // wallet row, no matter which path we took.
  // Legacy `base:<refereeId>` keys from the pre-consolidation rollout also
  // count as "already paid" so we never double-credit older test data.
  const already = await WalletTransaction.findOne({
    where: {
      type: 'referral_payout',
      referenceType: 'referral',
      referenceId: { [Op.in]: [`payout:${referee.id}`, `base:${referee.id}`] },
    },
    attributes: ['id'],
  });
  if (already) return null;

  // Evaluate the tier with this referee included. If the tier matches AND
  // this is the FIRST time it has matched for this referrer, the triggering
  // (last) referee gets a single combined payout = tier total minus what
  // earlier referees already pulled in as base.
  const prior = await fetchPriorQualifiedReferees(referrer.id, referee.id);
  const allQualifying = [
    ...prior,
    { refereeId: referee.id, firstPaidAt: booking.paidAt || new Date() },
  ].sort((a, b) => a.firstPaidAt - b.firstPaidAt);

  const matchedTier = evaluateTier(config.tiers || [], allQualifying.map((x) => x.firstPaidAt));

  // Has this tier already been satisfied for an OLDER window? (Defensive —
  // current evaluateTier only matches when count === atCount exactly, so
  // this shouldn't fire, but the check costs nothing and stops bugs.)
  let tierFirstHit = false;
  if (matchedTier) {
    const tierKey = `tier:${matchedTier.atCount}:${matchedTier.withinDays}`;
    const tierPaidBefore = await WalletTransaction.findOne({
      where: {
        type: 'referral_payout',
        referenceType: 'referral',
        referenceId: { [Op.like]: `${tierKey}:%` },
      },
      attributes: ['id'],
    });
    tierFirstHit = !tierPaidBefore;
  }

  let amountPaise;
  let label;
  if (matchedTier && tierFirstHit) {
    // The triggering referee earns: tier total — earlier base payouts.
    // e.g. 3-in-10 tier ₹1200, base ₹300 → first 2 referees got ₹300 each
    // (total ₹600), this referee earns ₹600 in a single combined row.
    const earlierBaseTotal = config.baseAmountPaise * (matchedTier.atCount - 1);
    amountPaise = Math.max(config.baseAmountPaise, matchedTier.totalPayoutPaise - earlierBaseTotal);
    label = `Referral reward — ${referee.email} completed first booking · ${matchedTier.label || `${matchedTier.atCount}-in-${matchedTier.withinDays}-day bonus`}`;
  } else {
    amountPaise = config.baseAmountPaise;
    label = `Referral reward — ${referee.email} completed first booking`;
  }

  if (amountPaise <= 0) return null;

  const credit = await creditReferrerWallet({
    referrerId: referrer.id,
    amountPaise,
    refereeId: referee.id,
    bookingId: booking.id,
    kind: 'payout',
    label,
  });
  return credit ? [credit] : null;
};

// ─── Coupon validation / lifecycle (unchanged from v1) ────────────────────

const validateCouponFor = async ({ code, user, subtotalPaise, taxPaise }) => {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return { ok: false, reason: 'Please enter a coupon code' };

  // Friendly path when the user accidentally pastes their OWN referral code
  // into the coupon box. Referral codes are short (~6-8 chars, no prefix)
  // while real coupons start with a word like WELCOME-, PROMO-, etc.
  if (user?.referralCode && clean === String(user.referralCode).toUpperCase()) {
    return {
      ok: false,
      reason: `${clean} is your referral code — share it with friends to earn wallet credit, it can't be used as a coupon on your own booking.`,
    };
  }

  const coupon = await Coupon.findOne({ where: { code: clean } });
  if (!coupon || !coupon.isActive) {
    // Soft hint: if what they entered looks like a referral code (no hyphen,
    // matches another user's code), nudge them toward sharing instead of
    // typing it here.
    const looksLikeRefCode = !clean.includes('-') && clean.length <= 10;
    if (looksLikeRefCode) {
      const refMatch = await User.findOne({ where: { referralCode: clean }, attributes: ['id'] });
      if (refMatch) {
        return {
          ok: false,
          reason: `${clean} is a friend's referral code — those can't be applied as coupons. Coupon codes look like WELCOME-XXXX.`,
        };
      }
    }
    return { ok: false, reason: 'Coupon not found' };
  }
  if (coupon.userId && coupon.userId !== user.id) return { ok: false, reason: 'This coupon belongs to another account' };
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return { ok: false, reason: 'This coupon has expired' };
  if (coupon.usageLimit && coupon.timesUsed >= coupon.usageLimit) return { ok: false, reason: 'This coupon has already been used' };

  const grossPaise = (subtotalPaise || 0) + (taxPaise || 0);
  if (coupon.minOrderPaise && grossPaise < coupon.minOrderPaise) {
    return {
      ok: false,
      reason: `Min order ₹${(coupon.minOrderPaise / 100).toLocaleString()} not met`,
    };
  }

  let discountPaise;
  if (coupon.kind === 'percent') {
    discountPaise = Math.round((grossPaise * coupon.value) / 100);
    if (coupon.maxDiscountPaise) discountPaise = Math.min(discountPaise, coupon.maxDiscountPaise);
  } else {
    discountPaise = coupon.value;
  }
  discountPaise = Math.max(0, Math.min(discountPaise, grossPaise));

  return {
    ok: true,
    coupon,
    discountPaise,
    description: coupon.description,
  };
};

const consumeCoupon = async ({ coupon }) => {
  if (!coupon) return;
  await coupon.increment('timesUsed', { by: 1 });
};

const restoreCoupon = async ({ code }) => {
  if (!code) return;
  const coupon = await Coupon.findOne({ where: { code: String(code).toUpperCase() } });
  if (!coupon) return;
  if (coupon.timesUsed > 0) {
    await coupon.decrement('timesUsed', { by: 1 });
  }
};

// ─── Wallet debit / refund for bookings (unchanged from v1) ───────────────

const debitWalletForBooking = async ({ userId, amountPaise, bookingId }) => {
  if (!amountPaise || amountPaise <= 0) return null;
  return sequelize.transaction(async (tx) => {
    const user = await User.findByPk(userId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!user) throw new Error('User not found');
    const balance = user.walletBalancePaise || 0;
    if (balance < amountPaise) throw new Error('Insufficient wallet balance');
    user.walletBalancePaise = balance - amountPaise;
    await user.save({ transaction: tx });
    await WalletTransaction.create({
      userId,
      amountPaise: -amountPaise,
      balanceAfterPaise: user.walletBalancePaise,
      type: 'booking_used',
      referenceType: 'booking',
      referenceId: String(bookingId),
      description: `Applied to booking`,
    }, { transaction: tx });
    return user.walletBalancePaise;
  });
};

const refundWalletForBooking = async ({ userId, amountPaise, bookingId }) => {
  if (!amountPaise || amountPaise <= 0) return null;

  const already = await WalletTransaction.findOne({
    where: { userId, type: 'booking_refund', referenceType: 'booking', referenceId: String(bookingId) },
    attributes: ['id'],
  });
  if (already) return null;

  return sequelize.transaction(async (tx) => {
    const user = await User.findByPk(userId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!user) return null;
    user.walletBalancePaise = (user.walletBalancePaise || 0) + amountPaise;
    await user.save({ transaction: tx });
    await WalletTransaction.create({
      userId,
      amountPaise,
      balanceAfterPaise: user.walletBalancePaise,
      type: 'booking_refund',
      referenceType: 'booking',
      referenceId: String(bookingId),
      description: 'Refund — booking cancelled',
    }, { transaction: tx });
    return user.walletBalancePaise;
  });
};

module.exports = {
  getDefaultConfig,
  loadConfig,
  evaluateTier,
  capWalletForBooking,
  creditReferrerForFirstLogin,
  creditReferrerForFirstPaid,
  validateCouponFor,
  consumeCoupon,
  restoreCoupon,
  debitWalletForBooking,
  refundWalletForBooking,
  generateCouponCode,
};

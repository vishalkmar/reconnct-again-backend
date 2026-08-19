const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { FraudEvent, FraudBlockedEmail, User } = require('../models');
const { ok, fail } = require('../utils/response');

/*
  Admin → Security → Payment Fraud Detection.

  Read-only reporting over the fraud_events table plus the admin-only actions
  (change a case's status, unfreeze an account). Admin-guarded at the route.
*/

const rup = (paise) => Number(paise || 0) / 100;

const listRow = (e) => {
  const j = e.toJSON ? e.toJSON() : e;
  return {
    id: j.id,
    bookingCode: j.bookingCode,
    userEmail: j.userEmail,
    userName: j.userName,
    expected: rup(j.expectedPaise),
    paid: rup(j.paidPaise),
    shortfall: rup(j.shortfallPaise),
    couponCode: j.couponCode || null,
    reason: j.reason,
    severity: j.severity,
    status: j.status,
    detectedAt: j.detectedAt,
    item: j.itemDetails?.name || null,
  };
};

// GET /api/admin/security/fraud?status=&q=
const listFraud = asyncHandler(async (req, res) => {
  const where = {};
  if (['open', 'reviewed', 'dismissed'].includes(req.query.status)) where.status = req.query.status;
  if (req.query.q) {
    const q = `%${String(req.query.q).trim()}%`;
    where[Op.or] = [{ bookingCode: { [Op.like]: q } }, { userEmail: { [Op.like]: q } }, { userName: { [Op.like]: q } }];
  }
  const rows = await FraudEvent.findAll({ where, order: [['detectedAt', 'DESC']], limit: 500 });

  const [openCount, total, frozenCount] = await Promise.all([
    FraudEvent.count({ where: { status: 'open' } }),
    FraudEvent.count(),
    FraudBlockedEmail.count({ where: { isActive: true } }),
  ]);
  const totalShortfall = rows.reduce((a, r) => a + rup(r.shortfallPaise), 0);

  return ok(res, {
    items: rows.map(listRow),
    summary: {
      open: openCount, total, frozenAccounts: frozenCount, shortfallShown: Math.round(totalShortfall * 100) / 100,
    },
  });
});

// GET /api/admin/security/fraud/:id — the full evidence blob.
const getFraud = asyncHandler(async (req, res) => {
  const e = await FraudEvent.findByPk(req.params.id);
  if (!e) return fail(res, 'Fraud event not found', 404);
  const j = e.toJSON();
  // Is this customer currently frozen?
  const frozen = j.userEmail
    ? await FraudBlockedEmail.findOne({ where: { email: j.userEmail, isActive: true }, attributes: ['id', 'frozenAt'] })
    : null;
  return ok(res, {
    event: {
      ...j,
      expected: rup(j.expectedPaise),
      paid: rup(j.paidPaise),
      shortfall: rup(j.shortfallPaise),
      couponDiscount: rup(j.couponDiscountPaise),
    },
    frozen: !!frozen,
    frozenAt: frozen?.frozenAt || null,
  });
});

// PATCH /api/admin/security/fraud/:id/status  { status, note }
const updateFraudStatus = asyncHandler(async (req, res) => {
  const e = await FraudEvent.findByPk(req.params.id);
  if (!e) return fail(res, 'Fraud event not found', 404);
  const status = ['open', 'reviewed', 'dismissed'].includes(req.body.status) ? req.body.status : e.status;
  await e.update({ status, adminNote: req.body.note !== undefined ? String(req.body.note || '') : e.adminNote });
  return ok(res, { id: e.id, status: e.status }, 'Updated');
});

// GET /api/admin/security/frozen — currently frozen accounts.
const listFrozen = asyncHandler(async (req, res) => {
  const rows = await FraudBlockedEmail.findAll({ where: { isActive: true }, order: [['frozenAt', 'DESC']], limit: 500 });
  return ok(res, { items: rows.map((r) => r.toJSON()) });
});

// POST /api/admin/security/frozen/:id/unfreeze — only an admin can lift a freeze.
const unfreeze = asyncHandler(async (req, res) => {
  const row = await FraudBlockedEmail.findByPk(req.params.id);
  if (!row) return fail(res, 'Not found', 404);
  await row.update({ isActive: false, unfrozenAt: new Date(), unfrozenByAdminId: req.admin ? req.admin.id : null });
  // Re-enable the user row so they can sign in again.
  try { await User.update({ isActive: true }, { where: { email: row.email } }); } catch { /* ignore */ }
  return ok(res, { email: row.email }, 'Account unfrozen — the user can sign in again');
});

// POST /api/admin/security/unfreeze-email  { email } — unfreeze by address
// (used from a fraud-event detail where we hold the email, not the freeze id).
const unfreezeByEmail = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email) return fail(res, 'Email required', 400);
  const row = await FraudBlockedEmail.findOne({ where: { email } });
  if (row) await row.update({ isActive: false, unfrozenAt: new Date(), unfrozenByAdminId: req.admin ? req.admin.id : null });
  try { await User.update({ isActive: true }, { where: { email } }); } catch { /* ignore */ }
  return ok(res, { email }, 'Account unfrozen');
});

module.exports = {
  listFraud, getFraud, updateFraudStatus, listFrozen, unfreeze, unfreezeByEmail,
};

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, Supplier, TeamMember, User,
} = require('../models');
const { ok, fail } = require('../utils/response');

const INCLUDE = [
  { model: ExperienceCategory, as: 'category', attributes: ['id', 'name', 'slug', 'icon'] },
  { model: ExperienceType, as: 'type', attributes: ['id', 'name', 'slug'] },
  { model: Supplier, as: 'supplier', attributes: ['id', 'companyName', 'supplierName'] },
];

// A "self-service" submission — Host (ownerUserId) or a Supplier's own login
// (supplierId, Phase 4) — is flagged inside the free-form `data` JSON blob
// (data.hostStatus === 'pending') rather than the `status` column, since
// that's how host.controller.js already worked before this phase (both now
// share the same createMine/updateMine code). A BD/staff submission is
// flagged via the real `status` column instead (forced in
// experience.controller.js's create()) and takes priority if somehow both
// are set (e.g. BD picked an existing supplier for their own submission —
// that's still a staff submission, not the supplier's own).
const isSelfServicePending = (exp) => (
  !exp.createdByTeamMemberId
  && (exp.ownerUserId || exp.supplierId)
  && exp.status === 'draft'
  && exp.data && exp.data.hostStatus === 'pending'
);
const isStaffPending = (exp) => !!exp.createdByTeamMemberId && exp.status === 'pending_review';
const isReviewable = (exp) => isStaffPending(exp) || isSelfServicePending(exp);

// Attaches a uniform `source` block so the queue UI can show/badge/filter by
// where a submission came from without caring about the underlying storage
// quirk above.
const withSource = async (items) => {
  const teamIds = [...new Set(items.filter((e) => e.createdByTeamMemberId).map((e) => e.createdByTeamMemberId))];
  const userIds = [...new Set(items.filter((e) => e.ownerUserId).map((e) => e.ownerUserId))];
  const [members, users] = await Promise.all([
    teamIds.length ? TeamMember.findAll({ where: { id: teamIds }, attributes: ['id', 'name', 'employeeCode', 'roleType'] }) : [],
    userIds.length ? User.findAll({ where: { id: userIds }, attributes: ['id', 'name', 'email'] }) : [],
  ]);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const userById = new Map(users.map((u) => [u.id, u]));

  return items.map((exp) => {
    const j = exp.toJSON ? exp.toJSON() : exp;
    if (j.createdByTeamMemberId) {
      const m = memberById.get(j.createdByTeamMemberId);
      j.source = { kind: 'staff', label: m ? `${m.name} (${m.employeeCode})` : 'Team member', roleType: m?.roleType };
    } else if (j.ownerUserId) {
      const u = userById.get(j.ownerUserId);
      j.source = { kind: 'host', label: u ? (u.name || u.email) : 'Host' };
    } else if (j.supplierId) {
      j.source = { kind: 'supplier', label: j.supplier?.companyName || 'Supplier' };
    } else {
      j.source = { kind: 'admin', label: 'Admin' };
    }
    return j;
  });
};

// GET /api/team/review-queue — everything currently awaiting Center Ops
// action, newest-submitted first. A QCOPS-role team member only sees what's
// been escalated to THEM specifically (Center Ops assigns, QCOPS actions) —
// a COPS-role member (or admin) sees the full queue regardless.
const list = asyncHandler(async (req, res) => {
  const where = {
    [Op.or]: [
      { status: 'pending_review' },
      { status: 'draft', ownerUserId: { [Op.ne]: null } },
      { status: 'draft', supplierId: { [Op.ne]: null }, createdByTeamMemberId: null },
    ],
  };
  if (req.teamMember && req.teamMember.roleType === 'qcops') {
    where.qcopsTeamMemberId = req.teamMember.id;
  }
  const candidates = await Experience.findAll({
    where,
    include: INCLUDE,
    order: [['updatedAt', 'DESC']],
  });
  const items = candidates.filter(isReviewable);
  return ok(res, { items: await withSource(items) });
});

// GET /api/team/review-queue/qcops-options — active QCOPS accounts, for the
// "Assign to QCOPS" picker.
const qcopsOptions = asyncHandler(async (req, res) => {
  const rows = await TeamMember.findAll({
    where: { roleType: 'qcops', isActive: true },
    attributes: ['id', 'name', 'employeeCode'],
    order: [['name', 'ASC']],
  });
  return ok(res, { items: rows });
});

const findReviewable = async (id) => {
  const item = await Experience.findByPk(id);
  if (!item) return null;
  if (!isReviewable(item)) return undefined; // exists but not actionable
  return item;
};

// POST /api/team/review-queue/:id/approve — goes live.
const approve = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  item.status = 'published';
  item.isActive = true;
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.reviewNote = null;
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'approved' };
  await item.save();

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Experience approved and published');
});

// POST /api/team/review-queue/:id/reject  { note }
const reject = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  const note = String(req.body?.note || '').trim();
  if (!note) return fail(res, 'A reason is required', 400);

  const wasSelfService = !!(item.ownerUserId || item.supplierId);
  item.status = 'archived';
  item.isActive = false;
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.reviewNote = note;
  if (wasSelfService) item.data = { ...(item.data || {}), hostStatus: 'draft' };
  await item.save();

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Experience rejected');
});

// POST /api/team/review-queue/:id/request-changes  { note }
// Sends it back to the creator to fix — BD resubmits via POST
// /api/experiences/:id/resubmit; host/supplier resubmit via their existing
// PUT /api/host(or supplier)/listings/:id { submit:true }.
const requestChanges = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  const note = String(req.body?.note || '').trim();
  if (!note) return fail(res, 'A note explaining the changes is required', 400);

  item.status = 'draft';
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.reviewNote = note;
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'draft' };
  await item.save();

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Sent back for changes');
});

// POST /api/team/review-queue/:id/assign-qcops  { qcopsTeamMemberId }
const assignQcops = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);

  const { qcopsTeamMemberId } = req.body || {};
  if (!qcopsTeamMemberId) {
    item.qcopsTeamMemberId = null;
    await item.save();
    return ok(res, {}, 'Unassigned');
  }
  const qcops = await TeamMember.findOne({ where: { id: qcopsTeamMemberId, roleType: 'qcops', isActive: true } });
  if (!qcops) return fail(res, 'That QCOPS account was not found', 400);

  item.qcopsTeamMemberId = qcops.id;
  await item.save();
  return ok(res, { qcops: { id: qcops.id, name: qcops.name, employeeCode: qcops.employeeCode } }, 'Assigned to QCOPS');
});

module.exports = {
  list, qcopsOptions, approve, reject, requestChanges, assignQcops,
};

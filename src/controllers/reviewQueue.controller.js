const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, Supplier, TeamMember, User,
} = require('../models');
const { ok, fail } = require('../utils/response');
const {
  applicableSections, decisionOf, summarize, SECTION_KEYS, LABEL_BY_KEY,
} = require('../utils/reviewSections');
const reviewNotify = require('../services/reviewNotify.service');

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
    // Compact per-section rollup + which pipeline lane this belongs in.
    j.review = {
      stage: j.reviewStage || 'submitted',
      round: j.reviewRound || 0,
      // "Follow-up" lane = it came back after the submitter fixed objections.
      lane: j.reviewStage === 'resubmitted' ? 'followup' : 'new',
      summary: summarize(j),
    };
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

// The review meta the sectioned detail page needs. The full experience
// content itself is fetched separately via GET /api/experiences/:id (already
// fully hydrated) so we don't duplicate that hydration here.
const reviewMeta = async (item) => {
  const j = item.toJSON ? item.toJSON() : item;
  const rs = j.reviewSections || {};
  const sections = applicableSections(j).map((s) => ({
    key: s.key,
    label: s.label,
    decision: decisionOf(rs, s.key),
    objection: rs[s.key]?.objection || '',
  }));
  const summary = summarize(j);
  const withSrc = (await withSource([item]))[0];
  return {
    id: j.id,
    stage: j.reviewStage || 'submitted',
    round: j.reviewRound || 0,
    suggestion: j.reviewSuggestion || '',
    qcopsTeamMemberId: j.qcopsTeamMemberId || null,
    qcopsNote: (j.data && j.data.qcopsNote) || '',
    source: withSrc.source,
    sections,
    summary,
  };
};

// GET /api/team/review-queue/:id — the review state for the detail page.
const getOne = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);
  return ok(res, { review: await reviewMeta(item) });
});

// POST /api/team/review-queue/:id/section  { key, decision, objection? }
// Record (or clear) one section's decision. Incremental — persisted as COPS
// works through the page; nothing is sent to the submitter until Follow-up.
const decideSection = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  const key = String(req.body?.key || '');
  const decision = String(req.body?.decision || '');
  if (!SECTION_KEYS.includes(key)) return fail(res, 'Unknown section', 400);

  const rs = { ...(item.reviewSections || {}) };
  if (decision === 'clear') {
    delete rs[key]; // "Edit" — re-enable both buttons for this section
  } else if (decision === 'approved') {
    rs[key] = { decision: 'approved', objection: null, at: new Date().toISOString(), by: req.teamMember ? req.teamMember.id : null };
  } else if (decision === 'objection') {
    const objection = String(req.body?.objection || '').trim();
    if (!objection) return fail(res, 'A reason is required for an objection', 400);
    rs[key] = { decision: 'objection', objection, at: new Date().toISOString(), by: req.teamMember ? req.teamMember.id : null };
  } else {
    return fail(res, 'decision must be approved | objection | clear', 400);
  }

  item.reviewSections = rs;
  if (item.reviewStage === 'submitted' || item.reviewStage == null) item.reviewStage = 'in_review';
  await item.save();
  return ok(res, { review: await reviewMeta(item) }, 'Section updated');
});

// PUT /api/team/review-queue/:id/suggestion  { suggestion }
const saveSuggestion = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);
  item.reviewSuggestion = String(req.body?.suggestion || '').trim() || null;
  await item.save();
  return ok(res, { review: await reviewMeta(item) }, 'Suggestion saved');
});

// POST /api/team/review-queue/:id/final-approve — only when EVERY applicable
// section is approved. Publishes the experience live.
const finalApprove = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  const s = summarize(item);
  if (!s.allApproved) {
    return fail(res, `Every section must be approved first — ${s.pending} pending, ${s.objection} with objections`, 400);
  }

  item.status = 'published';
  item.isActive = true;
  item.reviewStage = 'approved';
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.reviewNote = null;
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'approved' };
  await item.save();

  await reviewNotify.notifySubmitter(item, {
    kind: 'approved',
    title: 'Experience approved 🎉',
    message: `"${item.name}" passed review and is now live.`,
    meta: { experienceName: item.name },
  }).catch(() => {});

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Experience approved and published');
});

// POST /api/team/review-queue/:id/follow-up  { suggestion? }
// At least one section must carry an objection. Sends the item back to the
// submitter carrying the per-section objections + optional suggestion.
const followUp = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  const s = summarize(item);
  if (!s.hasObjection) return fail(res, 'Add an objection to at least one section before starting a follow-up', 400);

  if (req.body?.suggestion !== undefined) {
    item.reviewSuggestion = String(req.body.suggestion || '').trim() || null;
  }
  // Back to the submitter, out of the active queue. reviewStage marks it as
  // "with the submitter"; the objections live on reviewSections.
  item.status = 'draft';
  item.reviewStage = 'follow_up';
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  // A short human summary of the objected sections for legacy reviewNote / lists.
  item.reviewNote = s.objections.map((o) => `${o.label}: ${o.objection}`).join('\n');
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'changes' };
  await item.save();

  await reviewNotify.notifySubmitter(item, {
    kind: 'follow_up',
    title: `Changes needed on "${item.name}"`,
    message: `${s.objection} section${s.objection > 1 ? 's have' : ' has'} an objection to address.`,
    meta: { experienceName: item.name, objections: s.objections, suggestion: item.reviewSuggestion || '', round: item.reviewRound || 0 },
  }).catch(() => {});

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Sent back to the submitter for follow-up');
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
  item.reviewStage = 'rejected';
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.reviewNote = note;
  if (wasSelfService) item.data = { ...(item.data || {}), hostStatus: 'draft' };
  await item.save();

  await reviewNotify.notifySubmitter(item, {
    kind: 'rejected',
    title: `"${item.name}" was rejected`,
    message: note,
    meta: { experienceName: item.name },
  }).catch(() => {});

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Experience rejected');
});

// POST /api/team/review-queue/:id/request-changes  { note }
// Legacy whole-item "send back" — kept for backward compatibility with any
// existing callers; the granular Follow-up flow above is the primary path now.
const requestChanges = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  const note = String(req.body?.note || '').trim();
  if (!note) return fail(res, 'A note explaining the changes is required', 400);

  item.status = 'draft';
  item.reviewStage = 'follow_up';
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.reviewNote = note;
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'changes' };
  await item.save();

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Sent back for changes');
});

// Least-loaded round-robin across active QCOPS accounts (mirrors the Account
// Manager service's self-correcting approach — picks whichever QCOPS currently
// holds the fewest assigned experiences).
const pickLeastLoadedQcops = async () => {
  const qcops = await TeamMember.findAll({ where: { roleType: 'qcops', isActive: true }, attributes: ['id', 'name', 'employeeCode'] });
  if (qcops.length === 0) return null;
  const counts = await Promise.all(
    qcops.map((q) => Experience.count({ where: { qcopsTeamMemberId: q.id } })),
  );
  let best = 0;
  for (let i = 1; i < qcops.length; i++) {
    if (counts[i] < counts[best] || (counts[i] === counts[best] && qcops[i].id < qcops[best].id)) best = i;
  }
  return qcops[best];
};

// POST /api/team/review-queue/:id/send-qcops  { note }
// One click → auto-assign the least-loaded QCOPS (round-robin) with the reason
// COPS entered. The item stays in the queue but is now scoped to that QCOPS.
const sendQcops = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  const note = String(req.body?.note || '').trim();
  if (!note) return fail(res, 'Describe the problem before sending it to QCOPS', 400);

  const qcops = await pickLeastLoadedQcops();
  if (!qcops) return fail(res, 'No active QCOPS account is available', 400);

  item.qcopsTeamMemberId = qcops.id;
  item.data = { ...(item.data || {}), qcopsNote: note, qcopsSentAt: new Date().toISOString() };
  await item.save();

  await reviewNotify.notify({
    recipientType: 'team', recipientId: qcops.id, experienceId: item.id,
    kind: 'qcops',
    title: `Assigned for quality check: "${item.name}"`,
    message: note,
    meta: { experienceName: item.name, from: req.teamMember ? req.teamMember.id : null },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });

  return ok(res, { qcops: { id: qcops.id, name: qcops.name, employeeCode: qcops.employeeCode } }, `Sent to QCOPS — ${qcops.name}`);
});

// POST /api/team/review-queue/:id/assign-qcops  { qcopsTeamMemberId }
// Manual pick (kept alongside the round-robin send-qcops above).
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
  list, qcopsOptions, getOne, decideSection, saveSuggestion,
  finalApprove, followUp, reject, requestChanges,
  sendQcops, assignQcops, LABEL_BY_KEY,
};

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, Supplier, TeamMember, User,
} = require('../models');
const { ok, fail } = require('../utils/response');
const { validateQcFeedback, QC_FEEDBACK_FIELDS } = require('../utils/qcFeedback');
const reviewNotify = require('../services/reviewNotify.service');
const { ensureAccountManagerAssigned } = require('../services/accountManager.service');

let mailer = null;
try { mailer = require('../pwa/services/mailer'); } catch { mailer = null; }

const INCLUDE = [
  { model: ExperienceCategory, as: 'category', attributes: ['id', 'name', 'slug', 'icon'] },
  { model: ExperienceType, as: 'type', attributes: ['id', 'name', 'slug'] },
  { model: Supplier, as: 'supplier', attributes: ['id', 'companyName', 'supplierName', 'email'] },
];

// The QC lifecycle lives on experiences that have a qcopsTeamMemberId + a
// reviewStage in the qc_* range.
const QC_STAGES = ['qc_assigned', 'qc_acknowledged', 'qc_onsite', 'qc_feedback'];

const findQc = async (id) => Experience.findByPk(id, { include: INCLUDE });

// Who submitted the experience → who a QC decision notifies (+ their email).
const submitterContact = async (exp) => {
  if (exp.createdByTeamMemberId) {
    const m = await TeamMember.findByPk(exp.createdByTeamMemberId, { attributes: ['id', 'name', 'email'] });
    return { recipientType: 'team', recipientId: exp.createdByTeamMemberId, email: m?.email, name: m?.name };
  }
  if (exp.ownerUserId) {
    const u = await User.findByPk(exp.ownerUserId, { attributes: ['id', 'name', 'email'] });
    return { recipientType: 'user', recipientId: exp.ownerUserId, email: u?.email, name: u?.name };
  }
  if (exp.supplierId) {
    const sup = await Supplier.findByPk(exp.supplierId, { attributes: ['id', 'companyName', 'email'] });
    return { recipientType: 'supplier', recipientId: exp.supplierId, email: sup?.email, name: sup?.companyName };
  }
  return null;
};

// ── QCOPS side ──────────────────────────────────────────────────────────

// GET /api/team/qc/mine — the QCOPS member's assigned on-site visits.
const mine = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: { qcopsTeamMemberId: req.teamMember.id, reviewStage: { [Op.in]: QC_STAGES } },
    include: INCLUDE,
    order: [['updatedAt', 'DESC']],
  });
  return ok(res, { items: rows.map((r) => r.toJSON()), fields: QC_FEEDBACK_FIELDS });
});

const ownAssigned = async (req, id) => {
  const item = await findQc(id);
  if (!item) return { err: 'notfound' };
  if (item.qcopsTeamMemberId !== req.teamMember.id) return { err: 'forbidden' };
  return { item };
};

const notifyAssigner = (item, payload) => {
  const copsId = item.qcReview?.assignedByCopsId;
  if (!copsId) return Promise.resolve();
  return reviewNotify.notify({ recipientType: 'team', recipientId: copsId, experienceId: item.id, ...payload }).catch(() => {});
};

// POST /api/team/qc/:id/ack — "Got it" (received the assignment).
const ack = asyncHandler(async (req, res) => {
  const { item, err } = await ownAssigned(req, req.params.id);
  if (err === 'notfound') return fail(res, 'Not found', 404);
  if (err === 'forbidden') return fail(res, 'Not your assignment', 403);
  item.qcReview = { ...(item.qcReview || {}), status: 'acknowledged', acknowledgedAt: new Date().toISOString() };
  item.reviewStage = 'qc_acknowledged';
  await item.save();
  await notifyAssigner(item, { kind: 'qc_ack', title: `QCOPS acknowledged: "${item.name}"`, message: `${req.teamMember.name} received the visit assignment.` });
  return ok(res, { item: item.toJSON() }, 'Acknowledged');
});

// POST /api/team/qc/:id/onsite — "I'm at the place point" (visit day).
const onsite = asyncHandler(async (req, res) => {
  const { item, err } = await ownAssigned(req, req.params.id);
  if (err === 'notfound') return fail(res, 'Not found', 404);
  if (err === 'forbidden') return fail(res, 'Not your assignment', 403);
  item.qcReview = { ...(item.qcReview || {}), status: 'onsite', onsiteConfirmedAt: new Date().toISOString() };
  item.reviewStage = 'qc_onsite';
  await item.save();
  await notifyAssigner(item, { kind: 'qc_onsite', title: `QCOPS is on-site: "${item.name}"`, message: `${req.teamMember.name} confirmed they are at the location.` });
  return ok(res, { item: item.toJSON() }, 'On-site confirmed');
});

// POST /api/team/qc/:id/feedback  { feedback }
const submitFeedback = asyncHandler(async (req, res) => {
  const { item, err } = await ownAssigned(req, req.params.id);
  if (err === 'notfound') return fail(res, 'Not found', 404);
  if (err === 'forbidden') return fail(res, 'Not your assignment', 403);

  const { error, feedback } = validateQcFeedback(req.body?.feedback);
  if (error) return fail(res, error, 400);

  item.qcReview = { ...(item.qcReview || {}), status: 'feedback', feedback, feedbackSubmittedAt: new Date().toISOString() };
  item.reviewStage = 'qc_feedback';
  await item.save();
  await notifyAssigner(item, {
    kind: 'qc_feedback',
    title: `QCOPS feedback ready: "${item.name}"`,
    message: `${req.teamMember.name} submitted the on-site feedback — approve or reject to finish.`,
    meta: { recommendation: feedback.recommendation, overallRating: feedback.overallRating },
  });
  reviewNotify.emitQueueChanged({ experienceId: item.id });
  return ok(res, { item: item.toJSON() }, 'Feedback submitted');
});

// ── COPS decision on the QC feedback ────────────────────────────────────

// POST /api/team/qc/:id/approve — QC passed → go live (web + app) + assign AM.
const approve = asyncHandler(async (req, res) => {
  const item = await findQc(req.params.id);
  if (!item) return fail(res, 'Not found', 404);
  if (item.reviewStage !== 'qc_feedback') return fail(res, 'This item has no QCOPS feedback to act on', 400);

  item.status = 'published';
  item.isActive = true;
  item.reviewStage = 'published';
  item.qcReview = { ...(item.qcReview || {}), status: 'approved', decision: 'approved', decidedByCopsId: req.teamMember ? req.teamMember.id : null, decidedAt: new Date().toISOString() };
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'approved' };
  await item.save();

  // Supplier-owned listings get an Account Manager (least-loaded round-robin).
  if (item.supplierId) ensureAccountManagerAssigned(item.supplierId).catch(() => {});

  await reviewNotify.notifySubmitter(item, {
    kind: 'approved',
    title: `"${item.name}" is now live 🎉`,
    message: 'It passed the on-site quality check and is published on the website and app.',
    meta: { experienceName: item.name },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });
  return ok(res, { item: item.toJSON() }, 'Approved and published');
});

// POST /api/team/qc/:id/reject  { reason } — QC failed → back to submitter.
const reject = asyncHandler(async (req, res) => {
  const item = await findQc(req.params.id);
  if (!item) return fail(res, 'Not found', 404);
  if (item.reviewStage !== 'qc_feedback') return fail(res, 'This item has no QCOPS feedback to act on', 400);

  const reason = String(req.body?.reason || '').trim();
  if (!reason) return fail(res, 'A rejection reason is required', 400);

  item.status = 'archived';
  item.isActive = false;
  item.reviewStage = 'qc_rejected';
  item.reviewNote = reason;
  item.qcReview = { ...(item.qcReview || {}), status: 'rejected', decision: 'rejected', decisionReason: reason, decidedByCopsId: req.teamMember ? req.teamMember.id : null, decidedAt: new Date().toISOString() };
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'draft' };
  await item.save();

  const contact = await submitterContact(item);
  if (contact) {
    await reviewNotify.notify({
      recipientType: contact.recipientType, recipientId: contact.recipientId, experienceId: item.id,
      kind: 'rejected',
      title: `"${item.name}" was rejected after the quality check`,
      message: reason,
      meta: { experienceName: item.name },
    }).catch(() => {});
    // Best-effort email.
    if (mailer && contact.email) {
      mailer.send({
        to: contact.email,
        subject: `Your experience "${item.name}" was not approved`,
        html: `<p>Hi ${contact.name || ''},</p><p>After the on-site quality check, your experience <strong>${item.name}</strong> could not be approved for the following reason:</p><blockquote>${reason}</blockquote><p>Please review and address it, then resubmit.</p>`,
        text: `Your experience "${item.name}" was rejected after the quality check. Reason: ${reason}`,
      }).catch(() => {});
    }
  }
  reviewNotify.emitQueueChanged({ experienceId: item.id });
  return ok(res, { item: item.toJSON() }, 'Rejected — the submitter has been notified');
});

// ── QCOPS Management (COPS analytics) ───────────────────────────────────

const perQcopsStats = async (qcopsId) => {
  const rows = await Experience.findAll({
    where: { qcopsTeamMemberId: qcopsId },
    attributes: ['id', 'name', 'status', 'reviewStage', 'isActive', 'qcReview', 'updatedAt'],
  });
  const s = { assigned: rows.length, pending: 0, feedbackGiven: 0, approved: 0, rejected: 0, live: 0 };
  for (const r of rows) {
    if (['qc_assigned', 'qc_acknowledged', 'qc_onsite'].includes(r.reviewStage)) s.pending += 1;
    if (r.qcReview?.feedbackSubmittedAt) s.feedbackGiven += 1;
    if (r.reviewStage === 'published') { s.approved += 1; }
    if (r.reviewStage === 'qc_rejected') s.rejected += 1;
    if (r.status === 'published' && r.isActive) s.live += 1;
  }
  return { stats: s, rows };
};

// GET /api/team/qc/management — every QCOPS with a stats summary.
const management = asyncHandler(async (req, res) => {
  const qcops = await TeamMember.findAll({ where: { roleType: 'qcops' }, attributes: ['id', 'name', 'email', 'employeeCode', 'isActive'], order: [['name', 'ASC']] });
  const items = await Promise.all(qcops.map(async (q) => {
    const { stats } = await perQcopsStats(q.id);
    return { id: q.id, name: q.name, email: q.email, employeeCode: q.employeeCode, isActive: q.isActive, stats };
  }));
  return ok(res, { items });
});

// GET /api/team/qc/management/:qcopsId — one QCOPS's detailed analytics.
const managementDetail = asyncHandler(async (req, res) => {
  const q = await TeamMember.findOne({ where: { id: req.params.qcopsId, roleType: 'qcops' }, attributes: ['id', 'name', 'email', 'employeeCode', 'isActive'] });
  if (!q) return fail(res, 'QCOPS member not found', 404);
  const { stats, rows } = await perQcopsStats(q.id);
  // Hydrate names/images for the listing table.
  const detailed = await Experience.findAll({
    where: { id: { [Op.in]: rows.map((r) => r.id).length ? rows.map((r) => r.id) : [0] } },
    include: INCLUDE,
    attributes: ['id', 'name', 'mainImage', 'status', 'reviewStage', 'isActive', 'qcReview', 'updatedAt', 'supplierId', 'createdByTeamMemberId', 'ownerUserId'],
    order: [['updatedAt', 'DESC']],
  });
  const listings = detailed.map((e) => {
    const j = e.toJSON();
    return {
      id: j.id,
      name: j.name,
      mainImage: j.mainImage,
      reviewStage: j.reviewStage,
      isLive: j.status === 'published' && j.isActive,
      recommendation: j.qcReview?.feedback?.recommendation || null,
      overallRating: j.qcReview?.feedback?.overallRating || null,
      visitDate: j.qcReview?.visitDate || null,
      qcStatus: j.qcReview?.status || null,
      supplier: j.supplier?.companyName || null,
    };
  });
  return ok(res, { qcops: q, stats, listings });
});

// GET /api/team/qc/feedback-schema — the QC form field definitions.
const feedbackSchema = asyncHandler(async (req, res) => ok(res, { fields: QC_FEEDBACK_FIELDS }));

module.exports = {
  mine, ack, onsite, submitFeedback, approve, reject,
  management, managementDetail, feedbackSchema,
};

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, Supplier, TeamMember, User,
} = require('../models');
const { ok, fail } = require('../utils/response');
const { validateQcFeedback, QC_FEEDBACK_FIELDS } = require('../utils/qcFeedback');
const { istToInstant } = require('../utils/istTime');
const reviewNotify = require('../services/reviewNotify.service');
const reviewEmail = require('../services/reviewEmail.service');
const { ensureAccountManagerAssigned, ensureHostAccountManagerAssigned, resolveUpResponder } = require('../services/accountManager.service');

let mailer = null;
try { mailer = require('../pwa/services/mailer'); } catch { mailer = null; }

const INCLUDE = [
  { model: ExperienceCategory, as: 'category', attributes: ['id', 'name', 'slug', 'icon'] },
  { model: ExperienceType, as: 'type', attributes: ['id', 'name', 'slug'] },
  { model: Supplier, as: 'supplier', attributes: ['id', 'companyName', 'supplierName', 'email', 'phone'] },
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

// GET /api/team/qc/mine — EVERYTHING assigned to this QCOPS across all stages
// (active visits + approved + rejected), plus a stats rollup for their board.
// Nothing is ever deleted from their view — final outcomes stay visible.
const mine = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: { qcopsTeamMemberId: req.teamMember.id },
    include: INCLUDE,
    order: [['updatedAt', 'DESC']],
  });
  const stats = { assigned: rows.length, pending: 0, awaitingDecision: 0, feedbackGiven: 0, approved: 0, rejected: 0, live: 0 };
  for (const r of rows) {
    if (['qc_assigned', 'qc_acknowledged', 'qc_onsite'].includes(r.reviewStage)) stats.pending += 1;
    // "Under process": feedback given, awaiting Center Ops to publish or reject.
    if (['qc_feedback', 'qc_passed', 'under_progress'].includes(r.reviewStage)) stats.awaitingDecision += 1;
    if (r.qcReview?.feedbackSubmittedAt) stats.feedbackGiven += 1;
    if (r.reviewStage === 'published') stats.approved += 1;
    // Rejected covers BOTH the old qc_rejected AND the new under-progress reject.
    if (['qc_rejected', 'rejected'].includes(r.reviewStage)) stats.rejected += 1;
    if (r.status === 'published' && r.isActive) stats.live += 1;
  }
  return ok(res, { items: rows.map((r) => r.toJSON()), fields: QC_FEEDBACK_FIELDS, stats });
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

// POST /api/team/qc/:id/ack  { visitDate, visitTime, note? }
// "Send acknowledgement with your schedule of visit." QCOPS now sets the
// date/time themselves (after coordinating with the supplier) and writes a
// note back to Center Ops. The date/time they pick is what later unlocks the
// "I'm at the location" button.
const ack = asyncHandler(async (req, res) => {
  const { item, err } = await ownAssigned(req, req.params.id);
  if (err === 'notfound') return fail(res, 'Not found', 404);
  if (err === 'forbidden') return fail(res, 'Not your assignment', 403);

  const visitDate = String(req.body?.visitDate || '').trim();
  const visitTime = String(req.body?.visitTime || '').trim();
  const note = String(req.body?.note || '').trim();
  if (!visitDate || !visitTime) return fail(res, 'Pick your visit date and time', 400);

  item.qcReview = {
    ...(item.qcReview || {}),
    status: 'acknowledged',
    visitDate,
    visitTime,
    ackNote: note || null,
    acknowledgedAt: new Date().toISOString(),
  };
  item.reviewStage = 'qc_acknowledged';
  await item.save();

  await notifyAssigner(item, {
    kind: 'qc_ack',
    title: `QCOPS scheduled the visit: "${item.name}"`,
    message: `${req.teamMember.name} will visit on ${visitDate} at ${visitTime}.${note ? ` Note: ${note}` : ''}`,
    meta: { visitDate, visitTime, note },
  });
  reviewEmail.notifyCopsQcSchedule({ exp: item, qcopsName: req.teamMember.name, visitDate, visitTime, note })
    .catch((e) => console.error('[review-email] qc schedule:', e.message));
  return ok(res, { item: item.toJSON() }, 'Acknowledgement sent with your schedule');
});

// POST /api/team/qc/:id/onsite — "I'm at the place point" (visit day).
const onsite = asyncHandler(async (req, res) => {
  const { item, err } = await ownAssigned(req, req.params.id);
  if (err === 'notfound') return fail(res, 'Not found', 404);
  if (err === 'forbidden') return fail(res, 'Not your assignment', 403);
  // Unlocks AT the scheduled slot and stays unlocked from then on — a QCOPS
  // who arrives late must still be able to confirm. Only "before the slot" is
  // blocked. The slot is an IST wall clock, so resolve it explicitly rather
  // than against the server's timezone (UTC in production).
  const qc = item.qcReview || {};
  if (qc.visitDate && qc.visitTime) {
    const visitAt = istToInstant(qc.visitDate, qc.visitTime);
    if (visitAt && Date.now() < visitAt.getTime()) {
      return fail(res, `You can confirm on-site only from your visit time (${qc.visitDate} ${qc.visitTime})`, 400);
    }
  }
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

  const rec = feedback.recommendation;
  const base = { ...(item.qcReview || {}), status: 'feedback', feedback, feedbackSubmittedAt: new Date().toISOString() };

  if (rec === 'approved') {
    // Straight approval → awaiting COPS "Live it Now" (Level 3).
    item.qcReview = base;
    item.reviewStage = 'qc_passed';
    await item.save();
    await notifyAssigner(item, {
      kind: 'qc_feedback',
      title: `Ready to go live: "${item.name}"`,
      message: `${req.teamMember.name} passed the on-site check — click "Live it Now" to publish.`,
      meta: { recommendation: rec, overallRating: feedback.overallRating },
    });
  } else {
    // Minor/major changes → Under Progress. A BD-submitted listing goes back to
    // that BD; a supplier's own submission has no BD, so it lands with the
    // supplier's Key Account Manager, who carries the same responsibilities.
    // The owner is stamped on the round so the answer can't drift if the
    // supplier is reassigned mid-round.
    const changeType = rec === 'approved_major' ? 'major' : 'minor';
    const responder = await resolveUpResponder(item).catch(() => null);
    item.qcReview = {
      ...base,
      changeType,
      changeDetails: feedback.changeDetails || '',
      upState: 'pending_bd',
      upResponderId: responder ? responder.teamMemberId : null,
      upResponderVia: responder ? responder.via : null,
    };
    item.reviewStage = 'under_progress';
    item.reviewNote = feedback.changeDetails || `QCOPS suggested ${changeType} changes.`;
    await item.save();
    await notifyAssigner(item, {
      kind: 'qc_feedback',
      title: `${changeType === 'major' ? 'Major' : 'Minor'} changes recommended: "${item.name}"`,
      message: feedback.changeDetails || '',
      meta: { recommendation: rec, changeType },
    });
    // Straight to whoever has to answer — the BD, or the Key Account Manager
    // on a supplier's own submission.
    if (responder) {
      await reviewNotify.notify({
        recipientType: 'team',
        recipientId: responder.teamMemberId,
        experienceId: item.id,
        kind: 'under_progress',
        title: `Changes suggested on "${item.name}"`,
        message: feedback.changeDetails || `QCOPS suggested ${changeType} changes — respond in Under Progress.`,
        meta: { changeType, changeDetails: feedback.changeDetails, experienceName: item.name, via: responder.via },
      }).catch(() => {});
    }
  }
  // Outcome goes by email to Center Ops (who decides next) AND to whoever
  // submitted it — BD or supplier — with the status QCOPS recorded.
  reviewEmail.notifyQcFeedback({
    exp: item, feedback, qcopsName: req.teamMember ? req.teamMember.name : '',
  }).catch((e) => console.error('[review-email] qc feedback:', e.message));

  reviewNotify.emitQueueChanged({ experienceId: item.id });
  return ok(res, { item: item.toJSON() }, 'Feedback submitted');
});

// ── COPS decision on the QC feedback ────────────────────────────────────

// Publish an item live (web + app) + assign an AM. Shared by the direct
// "Live it Now" (qc_passed) and the under-progress go-live (bd_approved) paths.
const publishLive = async (item, copsId) => {
  item.status = 'published';
  item.isActive = true;
  item.reviewStage = 'published';
  item.qcReview = { ...(item.qcReview || {}), status: 'approved', decision: 'approved', decidedByCopsId: copsId, decidedAt: new Date().toISOString() };
  item.data = { ...(item.data || {}), listedAt: item.data?.listedAt || new Date().toISOString(), ...((item.ownerUserId || item.supplierId) ? { hostStatus: 'approved' } : {}) };
  await item.save();
  if (item.supplierId) ensureAccountManagerAssigned(item.supplierId).catch(() => {});
  // A host owns their listings directly — they get a KAM from the same pool
  // the first time one of those listings goes live.
  if (item.ownerUserId) ensureHostAccountManagerAssigned(item.ownerUserId).catch(() => {});
  // The KAM (supplier or host) hears that one of their accounts just went live.
  reviewEmail.notifySupplierStakeholdersOfDecision(item, 'live').catch(() => {});
  // Ping the QCOPS who checked it, so their board moves it to Approved/Live.
  if (item.qcopsTeamMemberId) {
    reviewNotify.notify({ recipientType: 'team', recipientId: item.qcopsTeamMemberId, experienceId: item.id, kind: 'approved', title: `"${item.name}" is now live`, message: 'The listing you checked went live.' }).catch(() => {});
  }
  // One place tells EVERYONE (supplier + KAM + BD + COPS + QCOPS), email AND
  // in-app, with the right message each — see reviewEmail.notifyWentLive.
  reviewEmail.notifyWentLive(item).catch((e) => console.error('[review-email] went live:', e.message));
  reviewNotify.emitQueueChanged({ experienceId: item.id });
};

// POST /api/team/qc/:id/go-live — "Live it Now". Valid when QCOPS approved
// outright (qc_passed) OR the submitter approved the requested changes with a
// deadline (under_progress + bd_approved).
const goLive = asyncHandler(async (req, res) => {
  const item = await findQc(req.params.id);
  if (!item) return fail(res, 'Not found', 404);
  const okStage = item.reviewStage === 'qc_passed'
    || (item.reviewStage === 'under_progress' && item.qcReview?.upState === 'bd_approved');
  if (!okStage) return fail(res, 'This item is not ready to go live yet', 400);
  await publishLive(item, req.teamMember ? req.teamMember.id : null);
  return ok(res, { item: item.toJSON() }, 'Published — now live on web & app');
});

/*
  POST /api/team/qc/:id/up-ack — Center Ops's "Got it" on an Under Progress
  response. Half of a two-way handshake: the submitter (BD) can see their
  answer was actually picked up, rather than guessing. Purely an
  acknowledgement — it does NOT decide anything, so the Live it Now / Reject
  buttons stay exactly as they were.
*/
const upAck = asyncHandler(async (req, res) => {
  const item = await findQc(req.params.id);
  if (!item) return fail(res, 'Not found', 404);
  if (item.reviewStage !== 'under_progress') return fail(res, 'This item is not in Under Progress', 400);
  const qc = item.qcReview || {};
  if (!['bd_approved', 'bd_rejected'].includes(qc.upState)) {
    return fail(res, 'There is no submitter response to acknowledge yet', 400);
  }
  if (qc.copsAck) return fail(res, 'Already acknowledged', 400);

  const who = req.teamMember || null;
  item.qcReview = {
    ...qc,
    copsAck: { at: new Date().toISOString(), byId: who ? who.id : null, byName: who ? who.name : 'Center Ops' },
  };
  await item.save();

  await reviewNotify.notifySubmitter(item, {
    kind: 'up_ack_cops',
    title: `Center Ops acknowledged: "${item.name}"`,
    message: `${who ? who.name : 'Center Ops'} has received your response.`,
    meta: { experienceName: item.name, ackBy: 'cops' },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });

  return ok(res, { item: item.toJSON() }, 'Acknowledged — the submitter has been told');
});

// POST /api/team/qc/:id/up-reject  { reason? } — COPS finalises a rejection
// out of the Under Progress lane (usually confirming the submitter's rejection).
const upReject = asyncHandler(async (req, res) => {
  const item = await findQc(req.params.id);
  if (!item) return fail(res, 'Not found', 404);
  if (item.reviewStage !== 'under_progress') return fail(res, 'This item is not in Under Progress', 400);

  const reason = String(req.body?.reason || '').trim() || item.qcReview?.bdReason || item.qcReview?.changeDetails || 'Not approved at review level';
  item.status = 'archived';
  item.isActive = false;
  item.reviewStage = 'rejected';
  item.reviewNote = reason;
  item.qcReview = { ...(item.qcReview || {}), status: 'rejected', decision: 'rejected', decisionReason: reason, decidedByCopsId: req.teamMember ? req.teamMember.id : null, decidedAt: new Date().toISOString() };
  if (item.ownerUserId || item.supplierId) item.data = { ...(item.data || {}), hostStatus: 'draft' };
  await item.save();

  // Submitter: in-app + FCM push (notifySubmitter) and the styled email.
  await reviewNotify.notifySubmitter(item, {
    kind: 'rejected', title: `"${item.name}" was not approved`, message: reason, meta: { experienceName: item.name },
  }).catch(() => {});
  reviewEmail.notifySubmitterDecision({ exp: item, kind: 'rejected', note: reason }).catch(() => {});
  reviewEmail.notifySupplierStakeholdersOfDecision(item, 'rejected', reason).catch(() => {});
  // Ping the QCOPS who checked it → their board moves it to Rejected.
  if (item.qcopsTeamMemberId) {
    reviewNotify.notify({ recipientType: 'team', recipientId: item.qcopsTeamMemberId, experienceId: item.id, kind: 'rejected', title: `"${item.name}" was rejected`, message: reason }).catch(() => {});
  }
  reviewNotify.emitQueueChanged({ experienceId: item.id });
  return ok(res, { item: item.toJSON() }, 'Rejected — the submitter has been notified');
});

// POST /api/team/qc/:id/delist  { reason } — pull a LIVE listing off the
// platform with a reason (shows in everyone's Delisted tab).
const delist = asyncHandler(async (req, res) => {
  const item = await findQc(req.params.id);
  if (!item) return fail(res, 'Not found', 404);
  if (!(item.status === 'published' && item.isActive) && item.reviewStage !== 'published' && item.reviewStage !== 'live') {
    return fail(res, 'Only a live listing can be delisted', 400);
  }
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return fail(res, 'A delist reason is required', 400);

  item.status = 'archived';
  item.isActive = false;
  item.reviewStage = 'delisted';
  // KAM of whoever owns it hears about the delisting.
  reviewEmail.notifySupplierStakeholdersOfDecision(item, 'delisted', req.body?.reason).catch(() => {});
  item.data = { ...(item.data || {}), delistReason: reason, delistedAt: new Date().toISOString(), hostStatus: 'draft' };
  await item.save();

  await reviewNotify.notifySubmitter(item, {
    kind: 'rejected', title: `"${item.name}" was delisted`, message: reason, meta: { experienceName: item.name },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });
  return ok(res, { item: item.toJSON() }, 'Delisted from the platform');
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
    if (['qc_rejected', 'rejected'].includes(r.reviewStage)) s.rejected += 1;
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
  mine, ack, onsite, submitFeedback, goLive, upReject, delist,
  management, managementDetail, feedbackSchema, upAck,
};

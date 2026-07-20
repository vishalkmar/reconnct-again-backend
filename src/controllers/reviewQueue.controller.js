const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, Supplier, TeamMember, User,
} = require('../models');
const { ok, fail } = require('../utils/response');
const {
  applicableSections, decisionOf, summarize, SECTION_KEYS, LABEL_BY_KEY,
  snapshotSections, logObjections,
} = require('../utils/reviewSections');
const { copsTab, COPS_TABS } = require('../utils/experienceStatus');
const reviewNotify = require('../services/reviewNotify.service');
const { ensureAccountManagerAssigned } = require('../services/accountManager.service');

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
// Any pending_review item is reviewable regardless of who created it (BD,
// staff, OR an admin whose direct publish was routed through the pipeline).
const isStaffPending = (exp) => exp.status === 'pending_review';
const isReviewable = (exp) => isStaffPending(exp) || isSelfServicePending(exp);

// Attaches a uniform `source` block so the queue UI can show/badge/filter by
// where a submission came from without caring about the underlying storage
// quirk above.
const withSource = async (items) => {
  const teamIds = [...new Set(items.filter((e) => e.createdByTeamMemberId).map((e) => e.createdByTeamMemberId))];
  const userIds = [...new Set(items.filter((e) => e.ownerUserId).map((e) => e.ownerUserId))];
  const supplierIds = [...new Set(items.filter((e) => e.supplierId).map((e) => e.supplierId))];
  const [members, users, liveRows] = await Promise.all([
    teamIds.length ? TeamMember.findAll({ where: { id: teamIds }, attributes: ['id', 'name', 'employeeCode', 'roleType'] }) : [],
    userIds.length ? User.findAll({ where: { id: userIds }, attributes: ['id', 'name', 'email'] }) : [],
    // How many LIVE listings each supplier already has → whether they're onboarded.
    supplierIds.length ? Experience.findAll({ where: { supplierId: supplierIds, status: 'published', isActive: true }, attributes: ['id', 'supplierId'] }) : [],
  ]);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const liveCount = new Map();
  liveRows.forEach((r) => liveCount.set(r.supplierId, (liveCount.get(r.supplierId) || 0) + 1));

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
    const stage = j.reviewStage || 'submitted';
    const qcLike = stage === 'approved' || stage.startsWith('qc_');
    const supplierOnboarded = j.supplierId ? (liveCount.get(j.supplierId) || 0) > 0 : false;
    const fromSupplierPortal = j.data && j.data.submittedVia === 'supplier_portal';
    j.supplierOnboarded = supplierOnboarded;
    j.review = {
      stage,
      round: j.reviewRound || 0,
      // Lanes: qc (content-approved, in the QCOPS visit flow), followup (came
      // back after the submitter fixed objections), new (fresh content review).
      lane: qcLike ? 'qc' : (stage === 'resubmitted' ? 'followup' : 'new'),
      // The COPS-level tab (level1|level2|live_in_progress|under_progress|…).
      copsTab: copsTab(j),
      // An already-onboarded supplier (has a live listing) → COPS may list it
      // directly, QCOPS optional — whether it came from the supplier portal OR a
      // BD. The FIRST (not-onboarded) listing always goes through QCOPS.
      fromSupplierPortal: !!fromSupplierPortal,
      supplierOnboarded,
      canDirectList: supplierOnboarded && stage === 'approved',
      // Is the ball in COPS's court right now? While a follow-up sits with the
      // submitter the item still shows in Level 1, but every review endpoint
      // rejects it — so the UI must disable the Review action instead of
      // letting it through to a 400 toast.
      awaitingCops: isReviewable(j),
      summary: summarize(j),
      qc: j.qcReview ? {
        status: j.qcReview.status,
        visitDate: j.qcReview.visitDate,
        visitTime: j.qcReview.visitTime,
        recommendation: j.qcReview.feedback?.recommendation,
      } : null,
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

// GET /api/team/review-queue/board — every experience that has entered the
// pipeline, bucketed into the COPS levels (Level 1 / Level 2 / Live in progress
// / Under Progress / Active / Rejected / Delisted) + counts. A QCOPS-role member
// only sees items escalated to them.
const board = asyncHandler(async (req, res) => {
  const where = {};
  if (req.teamMember && req.teamMember.roleType === 'qcops') where.qcopsTeamMemberId = req.teamMember.id;
  const rows = await Experience.findAll({ where, include: INCLUDE, order: [['updatedAt', 'DESC']] });
  // Skip plain drafts that never entered review (admin scratch drafts).
  const inPipeline = rows.filter((r) => r.status !== 'draft' || r.reviewStage || (r.data && r.data.hostStatus === 'pending'));
  const items = await withSource(inPipeline);
  const counts = Object.fromEntries(COPS_TABS.map((t) => [t, 0]));
  items.forEach((i) => { counts[i.review.copsTab] = (counts[i.review.copsTab] || 0) + 1; });
  counts.all = items.length;
  return ok(res, { items, counts });
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
  const resolutions = j.reviewResolutions || {};
  const thread = j.reviewThread || {};
  const snapshot = j.reviewSnapshot || {};
  const sections = applicableSections(j).map((s) => {
    const res = resolutions[s.key];
    return {
      key: s.key,
      label: s.label,
      decision: decisionOf(rs, s.key),
      objection: rs[s.key]?.objection || '',
      // If this section was objected last round, what the submitter said/did.
      resolution: res ? { prevObjection: res.objection || '', note: res.note || '', changed: !!res.changed, at: res.at } : null,
      // The section's field values COPS last saw (baseline for a before/after diff).
      before: res ? (snapshot[s.key] || null) : null,
      // Full objection⇄resolution history for this section across rounds.
      thread: thread[s.key] || [],
    };
  });
  const summary = summarize(j);
  const withSrc = (await withSource([item]))[0];

  // Supplier-onboarding context so COPS can decide direct-list vs QCOPS — shown
  // for ANY submission (BD/supplier/admin) whose supplier is already onboarded.
  let existingLive = [];
  let supplierInfo = null;
  if (j.supplierId) {
    const rows = await Experience.findAll({
      where: { supplierId: j.supplierId, status: 'published', isActive: true },
      include: [{ model: ExperienceCategory, as: 'category', attributes: ['id', 'name'] }],
      attributes: ['id', 'name', 'location', 'city', 'nearbyLocation', 'createdByTeamMemberId', 'ownerUserId', 'data'],
      limit: 50,
    });
    const viaOf = (r) => (r.data && r.data.submittedVia === 'supplier_portal' ? 'supplier' : (r.createdByTeamMemberId ? 'bd' : 'admin'));
    existingLive = rows.slice(0, 12).map((r) => ({ id: r.id, name: r.name, location: r.location, city: r.city, nearbyLocation: r.nearbyLocation, category: r.category?.name || null, via: viaOf(r) }));
    const fromPortal = rows.filter((r) => viaOf(r) === 'supplier').length;
    const byBd = rows.filter((r) => viaOf(r) === 'bd').length;
    const totalAll = await Experience.count({ where: { supplierId: j.supplierId } });
    const supplierRow = j.supplier?.companyName ? null : await Supplier.findByPk(j.supplierId, { attributes: ['companyName'] });
    supplierInfo = { companyName: j.supplier?.companyName || supplierRow?.companyName || null, live: rows.length, fromPortal, byBd, byAdmin: rows.length - fromPortal - byBd, total: totalAll };
  }
  const fromSupplierPortal = !!(j.data && j.data.submittedVia === 'supplier_portal');
  const supplierOnboarded = existingLive.length > 0;

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
    fromSupplierPortal,
    supplierOnboarded,
    supplierInfo,
    // Known/onboarded supplier → COPS may list directly (BD OR supplier source),
    // QCOPS optional. The FIRST listing (not onboarded) always goes via QCOPS.
    canDirectList: supplierOnboarded && j.reviewStage === 'approved',
    existingLive,
    thisVia: fromSupplierPortal ? 'supplier' : (j.createdByTeamMemberId ? 'bd' : (j.ownerUserId ? 'host' : 'admin')),
    current: { location: j.location || '', city: j.city || '', nearbyLocation: j.nearbyLocation || '', category: (j.categoryItems && j.categoryItems[0]?.name) || null },
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

  // Content review passed — NOT live yet. This only unlocks the QCOPS on-site
  // quality check (the real go-live gate). The item stays in the queue with
  // its QCOPS button now enabled.
  item.reviewStage = 'approved';
  item.isActive = false; // still not live — the QCOPS visit is the go-live gate
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.reviewNote = null;
  await item.save();

  await reviewNotify.notifySubmitter(item, {
    kind: 'section_approved',
    title: `"${item.name}" passed content review`,
    message: 'It now awaits an on-site quality check before it goes live.',
    meta: { experienceName: item.name },
  }).catch(() => {});

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Content approved — send it for an on-site QCOPS check to go live');
});

// POST /api/team/review-queue/:id/direct-list — publish straight to live
// (skipping QCOPS) for an ALREADY-ONBOARDED supplier after the content review
// is done — whether the submission came from the supplier portal OR a BD.
const directList = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);
  if (item.reviewStage !== 'approved') return fail(res, 'Finish the content review (Final Approve) first', 400);
  const liveCount = item.supplierId
    ? await Experience.count({ where: { supplierId: item.supplierId, status: 'published', isActive: true } })
    : 0;
  if (liveCount === 0) return fail(res, 'This supplier isn’t onboarded yet — send it to QCOPS instead', 400);

  item.status = 'published';
  item.isActive = true;
  item.reviewStage = 'published';
  item.reviewedByTeamMemberId = req.teamMember ? req.teamMember.id : null;
  item.reviewedAt = new Date();
  item.data = { ...(item.data || {}), hostStatus: 'approved', listedAt: item.data?.listedAt || new Date().toISOString() };
  await item.save();
  if (item.supplierId) ensureAccountManagerAssigned(item.supplierId).catch(() => {});

  await reviewNotify.notifySubmitter(item, {
    kind: 'approved',
    title: `"${item.name}" is now live 🎉`,
    message: 'Listed directly by Center Ops — it’s published on the website and app.',
    meta: { experienceName: item.name },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: (await withSource([full]))[0] }, 'Listed directly — now live');
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
  // Snapshot the current section content so the submitter's fixes can be
  // diffed against what COPS actually objected to. Clear last round's notes.
  item.reviewSnapshot = snapshotSections(item);
  item.reviewResolutions = null;
  // Log COPS's objections for this round into the persistent per-section chat.
  item.reviewThread = logObjections(item.reviewThread, item.reviewSections, item.reviewRound || 0);
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

// POST /api/team/review-queue/:id/send-qcops  { visitDate, visitTime, instructions }
// Only after the content review is fully approved. Auto-assigns the least-loaded
// QCOPS (round-robin) and schedules an on-site visit with instructions.
const sendQcops = asyncHandler(async (req, res) => {
  const item = await findReviewable(req.params.id);
  if (item === null) return fail(res, 'Experience not found', 404);
  if (item === undefined) return fail(res, 'This experience is not awaiting review', 400);

  if (item.reviewStage !== 'approved') {
    return fail(res, 'Finish the content review (Final Approve) before scheduling a QCOPS visit', 400);
  }

  const visitDate = String(req.body?.visitDate || '').trim();
  const visitTime = String(req.body?.visitTime || '').trim();
  const instructions = String(req.body?.instructions || '').trim();
  if (!visitDate || !visitTime) return fail(res, 'Choose a visit date and time', 400);
  if (!instructions) return fail(res, 'Add instructions for the QCOPS visit', 400);

  const qcops = await pickLeastLoadedQcops();
  if (!qcops) return fail(res, 'No active QCOPS account is available', 400);

  item.qcopsTeamMemberId = qcops.id;
  item.reviewStage = 'qc_assigned';
  item.qcReview = {
    status: 'assigned',
    visitDate,
    visitTime,
    instructions,
    assignedByCopsId: req.teamMember ? req.teamMember.id : null,
    assignedAt: new Date().toISOString(),
  };
  await item.save();

  await reviewNotify.notify({
    recipientType: 'team', recipientId: qcops.id, experienceId: item.id,
    kind: 'qcops',
    title: `On-site quality check assigned: "${item.name}"`,
    message: `Visit on ${visitDate} at ${visitTime}. ${instructions}`,
    meta: { experienceName: item.name, visitDate, visitTime, instructions },
  }).catch(() => {});
  // "First level approved" — tell the submitter it's cleared content review and
  // is now in the on-site quality-check stage.
  await reviewNotify.notifySubmitter(item, {
    kind: 'section_approved',
    title: `"${item.name}" cleared content review`,
    message: 'It’s now in the on-site quality-check stage.',
    meta: { experienceName: item.name },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });

  return ok(res, { qcops: { id: qcops.id, name: qcops.name, employeeCode: qcops.employeeCode } }, `Assigned to QCOPS — ${qcops.name}`);
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
  list, board, qcopsOptions, getOne, decideSection, saveSuggestion,
  finalApprove, directList, followUp, reject, requestChanges,
  sendQcops, assignQcops, LABEL_BY_KEY,
};

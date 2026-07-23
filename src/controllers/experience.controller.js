const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, ExperienceAudience, Supplier,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const { ensureAccountManagerAssigned, mayRespondToUp } = require('../services/accountManager.service');
const {
  summarize, resetForNewRound, buildRoundResolutions, sectionChanged, logResolutions,
} = require('../utils/reviewSections');
const reviewNotify = require('../services/reviewNotify.service');
const reviewEmail = require('../services/reviewEmail.service');
const { validateImagesForSubmit } = require('../utils/experienceValidation');

// Columns the form is allowed to write. Everything else the client sends is
// ignored (anything genuinely freeform should go inside `data`).
const WRITABLE = [
  'name', 'audiences', 'categoryIds', 'typeIds', 'supplierId', 'showSupplierPublic', 'location', 'city', 'nearbyLocation', 'latitude', 'longitude',
  'rating', 'about', 'mainImage', 'gallery', 'videos', 'mode', 'status',
  'priceMethod', 'pricing', 'currency', 'gstRate', 'discount', 'convenienceFee',
  'termsConditions', 'privacyPolicy', 'refundCancellationPolicy',
  'inclusions', 'faqs', 'facilities', 'nearbyPlaces', 'schedule', 'data',
  'isActive', 'isFeatured', 'sortOrder',
];

const uniqueSlug = async (base, ignoreId = null) => {
  let root = slugify(String(base || ''), { lower: true, strict: true }) || `experience-${Date.now()}`;
  let candidate = root;
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Experience.findOne({ where: { slug: candidate, ...(ignoreId ? { id: { [Op.ne]: ignoreId } } : {}) } })) {
    candidate = `${root}-${i++}`;
    if (i > 60) break;
  }
  return candidate;
};

const pickWritable = (body) => {
  const out = {};
  for (const k of WRITABLE) if (k in body) out[k] = body[k];
  if (out.audiences && !Array.isArray(out.audiences)) out.audiences = [];
  if ('categoryIds' in out && !Array.isArray(out.categoryIds)) out.categoryIds = out.categoryIds ? [out.categoryIds] : [];
  if ('typeIds' in out && !Array.isArray(out.typeIds)) out.typeIds = out.typeIds ? [out.typeIds] : [];
  // categoryId/typeId (single) are kept in sync as the first selected id —
  // every consumer that still expects a single value (public browse filter,
  // badge displays, the host web/app wizards) keeps working unchanged. Only
  // touched when the client actually sent categoryIds/typeIds, so a partial
  // update never wipes an experience's existing categories/types.
  if ('categoryIds' in out) out.categoryId = out.categoryIds[0] || null;
  if ('typeIds' in out) out.typeId = out.typeIds[0] || null;
  return out;
};

const INCLUDE = [
  { model: ExperienceCategory, as: 'category', attributes: ['id', 'name', 'slug', 'icon', 'colorHex'] },
  { model: ExperienceType, as: 'type', attributes: ['id', 'name', 'slug', 'categoryId'] },
  { model: Supplier, as: 'supplier', attributes: ['id', 'companyName', 'supplierName', 'phone', 'email', 'image', 'createdAt'] },
];

// Attach the hydrated audience/category/type objects (the row stores only ids).
const withAudiences = async (exp) => {
  const j = exp.toJSON ? exp.toJSON() : exp;
  const audIds = Array.isArray(j.audiences) ? j.audiences : [];
  const catIds = Array.isArray(j.categoryIds) ? j.categoryIds : [];
  const typeIds = Array.isArray(j.typeIds) ? j.typeIds : [];
  const [aud, cats, types] = await Promise.all([
    audIds.length ? ExperienceAudience.findAll({ where: { id: audIds } }) : [],
    catIds.length ? ExperienceCategory.findAll({ where: { id: catIds } }) : [],
    typeIds.length ? ExperienceType.findAll({ where: { id: typeIds } }) : [],
  ]);
  j.audienceItems = aud.map((a) => ({ id: a.id, name: a.name, slug: a.slug, icon: a.icon }));
  j.categoryItems = cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon }));
  j.typeItems = types.map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
  // Section-level review rollup so the submitter's dashboard can show which
  // sections carry objections (with counts/messages) without re-deriving it.
  const snap = j.reviewSnapshot || null;
  const rvSummary = summarize(j);
  // Tell the submitter, per objection, whether they've changed the section
  // since it was objected to (diff vs the follow-up snapshot) + the before state.
  rvSummary.objections = rvSummary.objections.map((o) => ({
    ...o,
    changed: sectionChanged(j, o.key, snap),
    before: snap ? snap[o.key] : null,
  }));
  j.review = {
    stage: j.reviewStage || null,
    round: j.reviewRound || 0,
    suggestion: j.reviewSuggestion || '',
    summary: rvSummary,
    thread: j.reviewThread || {},
  };
  return j;
};

// GET /api/experiences  (admin list)
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.supplierId) where.supplierId = parseInt(req.query.supplierId, 10);
  if (req.query.q) where.name = { [Op.like]: `%${req.query.q}%` };
  let items = await Experience.findAll({
    where,
    include: INCLUDE,
    order: [['sortOrder', 'ASC'], ['createdAt', 'DESC']],
  });
  // categoryIds/typeIds are JSON arrays — filtered in JS (same approach the
  // public browse endpoint uses for audienceId) rather than a JSON_CONTAINS
  // SQL clause, to stay portable across MySQL versions.
  if (req.query.categoryId) {
    const cid = parseInt(req.query.categoryId, 10);
    items = items.filter((e) => Array.isArray(e.categoryIds) && e.categoryIds.includes(cid));
  }
  if (req.query.typeId) {
    const tid = parseInt(req.query.typeId, 10);
    items = items.filter((e) => Array.isArray(e.typeIds) && e.typeIds.includes(tid));
  }

  // Bulk-hydrate categoryItems/typeItems (all selected categories/types, not
  // just the first) so the list table can show every badge, not one.
  const allCatIds = [...new Set(items.flatMap((e) => e.categoryIds || []))];
  const allTypeIds = [...new Set(items.flatMap((e) => e.typeIds || []))];
  const [cats, types] = await Promise.all([
    allCatIds.length ? ExperienceCategory.findAll({ where: { id: allCatIds } }) : [],
    allTypeIds.length ? ExperienceType.findAll({ where: { id: allTypeIds } }) : [],
  ]);
  const catById = new Map(cats.map((c) => [c.id, { id: c.id, name: c.name, slug: c.slug, icon: c.icon }]));
  const typeById = new Map(types.map((t) => [t.id, { id: t.id, name: t.name, slug: t.slug }]));
  const shaped = items.map((e) => {
    const j = e.toJSON ? e.toJSON() : e;
    j.categoryItems = (j.categoryIds || []).map((id) => catById.get(id)).filter(Boolean);
    j.typeItems = (j.typeIds || []).map((id) => typeById.get(id)).filter(Boolean);
    return j;
  });

  return ok(res, { items: shaped });
});

// GET /api/experiences/:id
const getOne = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id, { include: INCLUDE });
  if (!item) return fail(res, 'Experience not found', 404);
  return ok(res, { item: await withAudiences(item) });
});

// POST /api/experiences
const create = asyncHandler(async (req, res) => {
  const data = pickWritable(req.body);
  if (!data.name || !String(data.name).trim()) return fail(res, 'name is required', 400);
  data.slug = await uniqueSlug(req.body.slug || data.name);
  // A team member's submission always goes to Center Ops for review first —
  // whatever status the form requested is overridden. Admin's own direct
  // creates are completely unaffected (req.teamMember is only set when the
  // request came in on the team-portal auth path).
  if (req.teamMember) {
    // BD/staff submissions always go for review — enforce the global image rule.
    const imgErr = validateImagesForSubmit(data);
    if (imgErr) return fail(res, imgErr, 400);
    data.status = 'pending_review';
    data.createdByTeamMemberId = req.teamMember.id;
  } else if (data.status === 'published') {
    // GLOBAL RULE: nothing goes live without the COPS + QCOPS pipeline — even an
    // admin upload can't publish directly; it enters the review queue instead.
    const imgErr = validateImagesForSubmit(data);
    if (imgErr) return fail(res, imgErr, 400);
    data.status = 'pending_review';
  }
  const item = await Experience.create(data);
  if (item.supplierId) ensureAccountManagerAssigned(item.supplierId).catch(() => {});
  if (item.status === 'pending_review') {
    reviewNotify.notifyCopsTeam({
      experienceId: item.id,
      kind: 'submitted',
      title: `New submission: "${item.name}"`,
      meta: { experienceName: item.name },
    }).catch(() => {});
    reviewEmail.notifyCopsNewSubmission({ exp: item, via: req.teamMember ? req.teamMember.name : '' })
      .catch((e) => console.error('[review-email] new submission:', e.message));
  }
  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return created(res, { item: await withAudiences(full) }, 'Experience saved');
});

// PUT /api/experiences/:id
const update = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);

  // A team member may only edit their OWN submission, and only while it's
  // still editable (draft — e.g. Center Ops just sent it back with
  // changes). Once published/archived it's out of their hands. Admin is
  // unrestricted, same as before.
  if (req.teamMember) {
    if (item.createdByTeamMemberId !== req.teamMember.id) return fail(res, 'Not your submission', 403);
    if (item.status !== 'draft') return fail(res, 'This experience can no longer be edited', 400);
  }

  const data = pickWritable(req.body);
  if (req.body.slug !== undefined && req.body.slug !== item.slug) {
    data.slug = await uniqueSlug(req.body.slug, item.id);
  }
  await item.update(data);
  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: await withAudiences(full) }, 'Experience updated');
});

// POST /api/experiences/:id/duplicate
const duplicate = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);
  const j = item.toJSON();
  delete j.id; delete j.createdAt; delete j.updatedAt;
  j.name = `${j.name} (Copy)`;
  j.slug = await uniqueSlug(j.name);
  j.status = 'draft';
  const copy = await Experience.create(j);
  const full = await Experience.findByPk(copy.id, { include: INCLUDE });
  return created(res, { item: await withAudiences(full) }, 'Experience duplicated');
});

// PATCH /api/experiences/:id/toggle  — show/hide
const toggle = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { item }, `Experience ${item.isActive ? 'shown' : 'hidden'}`);
});

// DELETE /api/experiences/:id
const remove = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);
  await item.destroy();
  return ok(res, {}, 'Experience deleted');
});

// PUT /api/experiences/reorder  body: { order: [id,…] }
const reorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => Experience.update({ sortOrder: idx }, { where: { id } })));
  return ok(res, {}, 'Reordered');
});

// POST /api/experiences/:id/resubmit — a team member sends their own
// changes-requested/rejected submission back into the Center Ops queue.
// (Host listings resubmit through their existing PUT /host/listings/:id
// { submit:true } instead — untouched by this.)
const resubmit = asyncHandler(async (req, res) => {
  if (!req.teamMember) return fail(res, 'Only a team member submission can be resubmitted here', 400);
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);
  if (item.createdByTeamMemberId !== req.teamMember.id) return fail(res, 'Not your submission', 403);
  if (!['draft', 'archived'].includes(item.status)) return fail(res, 'This experience is not awaiting resubmission', 400);

  const imgErr = validateImagesForSubmit(item);
  if (imgErr) return fail(res, imgErr, 400);

  const isFollowUp = item.reviewStage === 'follow_up' || (item.reviewSections && Object.keys(item.reviewSections).length);
  // Require a resolution note for every objected section before it can go back.
  const { error: resErr, resolutions } = buildRoundResolutions(item, req.body?.resolutions);
  if (resErr) return fail(res, resErr, 400);

  item.status = 'pending_review';
  item.reviewNote = null;
  // "Review again" after a follow-up: keep the sections COPS already approved,
  // drop the objected ones back to pending, and mark it as a follow-up round
  // so it lands in the queue's Follow-up lane.
  if (isFollowUp) {
    item.reviewResolutions = resolutions;
    // Log the submitter's replies into the persistent per-section chat (against
    // the round they answer — before the round counter is bumped below).
    item.reviewThread = logResolutions(item.reviewThread, resolutions, item.reviewRound || 0);
    item.reviewSections = resetForNewRound(item.reviewSections);
    item.reviewStage = 'resubmitted';
    item.reviewRound = (item.reviewRound || 0) + 1;
  }
  // The follow-up marked data.hostStatus 'changes' for any supplier/host-linked
  // row (that's what the owner's portal reads). The round is over now, so clear
  // it — leaving it set kept a phantom "Objections" block on their card for the
  // rest of the listing's life.
  if (item.ownerUserId || item.supplierId) {
    item.data = { ...(item.data || {}), hostStatus: 'pending' };
  }
  await item.save();

  // Back in Center Ops's lap — ping the COPS team + live-refresh their queue.
  await reviewNotify.notifyCopsTeam({
    experienceId: item.id,
    kind: item.reviewStage === 'resubmitted' ? 'resubmitted' : 'submitted',
    title: item.reviewStage === 'resubmitted' ? `Re-submitted for review: "${item.name}"` : `New submission: "${item.name}"`,
    message: item.reviewStage === 'resubmitted' ? 'The submitter addressed the objections — ready for another look.' : null,
    meta: { experienceName: item.name, round: item.reviewRound || 0 },
  }).catch(() => {});
  reviewEmail.notifyCopsNewSubmission({
    exp: item,
    resubmitted: item.reviewStage === 'resubmitted',
    via: req.teamMember ? req.teamMember.name : '',
  }).catch((e) => console.error('[review-email] resubmission:', e.message));

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: await withAudiences(full) }, 'Resubmitted for review');
});

// POST /api/experiences/:id/up-respond  { decision:'reject'|'approve', reason, deadline? }
// The submitter's answer to a QCOPS minor/major-changes recommendation
// (Under Progress). Either answer moves it to Center Ops to finalise.
const upRespond = asyncHandler(async (req, res) => {
  if (!req.teamMember) return fail(res, 'Only a team member can respond here', 400);
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);
  // The submitting BD — or, on a supplier's own submission, the Key Account
  // Manager the round was handed to (see resolveUpResponder).
  if (!(await mayRespondToUp(item, req.teamMember.id))) return fail(res, 'This response is not yours to give', 403);
  if (item.reviewStage !== 'under_progress') return fail(res, 'This experience is not in Under Progress', 400);

  const decision = String(req.body?.decision || '');
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return fail(res, 'A reason is required', 400);

  if (decision === 'reject') {
    item.qcReview = { ...(item.qcReview || {}), upState: 'bd_rejected', bdReason: reason, bdRespondedAt: new Date().toISOString() };
  } else if (decision === 'approve') {
    const deadline = String(req.body?.deadline || '').trim();
    if (!deadline) return fail(res, 'A completion deadline (date & time) is required', 400);
    item.qcReview = { ...(item.qcReview || {}), upState: 'bd_approved', bdReason: reason, bdDeadline: deadline, bdRespondedAt: new Date().toISOString() };
  } else {
    return fail(res, 'decision must be reject or approve', 400);
  }
  await item.save();

  await reviewNotify.notifyCopsTeam({
    experienceId: item.id,
    kind: 'under_progress',
    title: `Under Progress response: "${item.name}"`,
    message: decision === 'reject' ? `Submitter wants to reject — ${reason}` : `Submitter accepted the changes (deadline set).`,
    meta: { decision, reason },
  }).catch(() => {});

  // Accepting the changes commits the SUPPLIER to doing the work, so they're
  // told at the same moment as Center Ops and must acknowledge in writing.
  // (A rejection never reaches them — nothing is being asked of them.)
  if (decision === 'approve' && item.supplierId) {
    const deadline = item.qcReview?.bdDeadline || null;
    // In-app bell + FCM push to the supplier's phone.
    await reviewNotify.notifySupplier(item.supplierId, {
      experienceId: item.id,
      kind: 'up_supplier_request',
      title: `Action needed on "${item.name}"`,
      message: `${item.qcReview?.changeDetails || 'Changes were requested after the on-site check.'}${deadline ? ` Please complete by ${deadline}.` : ''}`,
      meta: { experienceName: item.name, deadline },
    }).catch(() => {});
    // And an email spelling out the deadline.
    reviewEmail.notifySupplierChangeDeadline({ exp: item, deadline, details: item.qcReview?.changeDetails })
      .catch((e) => console.error('[review-email] supplier deadline:', e.message));
  }

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: await withAudiences(full) }, 'Response submitted');
});

// POST /api/experiences/:id/delist  { reason } — admin pulls a LIVE listing off
// the platform (web + app) with a reason. Shows in everyone's Delisted tab.
const delist = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);
  if (!(item.status === 'published' && item.isActive)) return fail(res, 'Only a live listing can be delisted', 400);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return fail(res, 'A delist reason is required', 400);

  item.status = 'archived';
  item.isActive = false;
  item.reviewStage = 'delisted';
  item.data = { ...(item.data || {}), delistReason: reason, delistedAt: new Date().toISOString(), hostStatus: 'draft' };
  await item.save();

  reviewNotify.notifySubmitter(item, {
    kind: 'rejected', title: `"${item.name}" was delisted`, message: reason, meta: { experienceName: item.name },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });

  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: await withAudiences(full) }, 'Delisted from the platform');
});

module.exports = {
  list, getOne, create, update, duplicate, toggle, remove, reorder, resubmit, upRespond, delist,
};

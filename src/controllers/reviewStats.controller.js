const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { Experience, Supplier } = require('../models');
const { ok, fail } = require('../utils/response');
const { objectionEntries } = require('../utils/reviewSections');
const { submitterTab, SUBMITTER_TABS } = require('../utils/experienceStatus');

// GET /api/team/review-stats/my-suppliers — the BD's onboarded suppliers with
// top stats + each supplier's listing counts by tab (drives the enhanced
// Suppliers tab).
const mySuppliers = asyncHandler(async (req, res) => {
  const suppliers = await Supplier.findAll({ where: { createdByTeamMemberId: req.teamMember.id }, order: [['createdAt', 'DESC']] });
  const ids = suppliers.map((s) => s.id);
  const exps = ids.length
    ? await Experience.findAll({ where: { supplierId: ids }, attributes: ['id', 'supplierId', 'status', 'isActive', 'reviewStage', 'data'] })
    : [];
  const now = new Date();
  const items = suppliers.map((s) => {
    const own = exps.filter((e) => e.supplierId === s.id);
    const listingCounts = Object.fromEntries(SUBMITTER_TABS.map((t) => [t, 0]));
    own.forEach((e) => { listingCounts[submitterTab(e)] += 1; });
    return { ...s.toSafeJSON(), listingCounts, totalListings: own.length };
  });
  const stats = {
    total: suppliers.length,
    thisMonth: suppliers.filter((s) => { const d = new Date(s.createdAt); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).length,
    active: suppliers.filter((s) => s.isActive).length,
    withLive: items.filter((s) => s.listingCounts.live > 0).length,
  };
  return ok(res, { items, stats });
});

// GET /api/team/review-stats/my-suppliers/:supplierId/experiences — one of the
// BD's suppliers' listings, tab-bucketed.
const mySupplierExperiences = asyncHandler(async (req, res) => {
  const supplier = await Supplier.findByPk(req.params.supplierId);
  if (!supplier) return fail(res, 'Supplier not found', 404);
  if (supplier.createdByTeamMemberId !== req.teamMember.id) return fail(res, 'This supplier is not yours', 403);
  const rows = await Experience.findAll({ where: { supplierId: supplier.id }, order: [['updatedAt', 'DESC']] });
  const items = rows.map((r) => {
    const j = r.toJSON();
    return {
      id: j.id, name: j.name, mainImage: j.mainImage, location: j.location || j.city || '',
      tab: submitterTab(j), reviewStage: j.reviewStage, reviewNote: j.reviewNote || null,
      delistReason: (j.data && j.data.delistReason) || null, createdAt: j.createdAt,
    };
  });
  const counts = Object.fromEntries(SUBMITTER_TABS.map((t) => [t, items.filter((i) => i.tab === t).length]));
  counts.all = items.length;
  return ok(res, { supplier: supplier.toSafeJSON(), items, counts });
});

// GET /api/team/review-stats/my-experiences — the member's own experiences
// bucketed into the submitter tabs (In Queue / Under Progress / Live /
// Rejected / Delisted) with everything the tabbed board + filters need.
const myExperiences = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: { createdByTeamMemberId: req.teamMember.id },
    include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'companyName', 'supplierName', 'email'] }],
    order: [['updatedAt', 'DESC']],
  });
  const items = rows.map((r) => {
    const j = r.toJSON();
    const objs = objectionEntries(j.reviewSections);
    return {
      id: j.id,
      name: j.name,
      mainImage: j.mainImage,
      location: j.location || j.city || '',
      supplier: j.supplier ? { id: j.supplier.id, name: j.supplier.companyName, email: j.supplier.email } : null,
      tab: submitterTab(j),
      reviewStage: j.reviewStage,
      round: j.reviewRound || 0,
      objections: objs,
      objectionCount: objs.length,
      reviewNote: j.reviewNote || null,
      suggestion: j.reviewSuggestion || null,
      qc: j.qcReview ? {
        status: j.qcReview.status,
        recommendation: j.qcReview.feedback?.recommendation,
        visitDate: j.qcReview.visitDate,
        changeType: j.qcReview.changeType || null,
        changeDetails: j.qcReview.changeDetails || null,
        upState: j.qcReview.upState || null,
        bdReason: j.qcReview.bdReason || null,
        bdDeadline: j.qcReview.bdDeadline || null,
        // Two-way handshake on the submitter's Under Progress response —
        // did Center Ops pick it up, and did the supplier commit in writing?
        copsAck: j.qcReview.copsAck || null,
        supplierAck: j.qcReview.supplierAck || null,
      } : null,
      delistReason: (j.data && j.data.delistReason) || null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    };
  });
  const counts = {};
  SUBMITTER_TABS.forEach((t) => { counts[t] = items.filter((i) => i.tab === t).length; });
  counts.all = items.length;
  return ok(res, { items, counts });
});

const CARD_ATTRS = ['id', 'name', 'mainImage', 'location', 'status', 'reviewStage', 'reviewRound',
  'reviewSections', 'reviewSuggestion', 'reviewNote', 'supplierId', 'createdByTeamMemberId', 'ownerUserId', 'data'];

const isSelfServicePending = (e) => (!e.createdByTeamMemberId && (e.ownerUserId || e.supplierId) && e.status === 'draft' && e.data && e.data.hostStatus === 'pending');
const isStaffPending = (e) => e.status === 'pending_review';
const isReviewable = (e) => isStaffPending(e) || isSelfServicePending(e);

const card = (e) => {
  const j = e.toJSON ? e.toJSON() : e;
  const objs = objectionEntries(j.reviewSections);
  return {
    id: j.id,
    name: j.name,
    mainImage: j.mainImage,
    location: j.location,
    round: j.reviewRound || 0,
    objections: objs,
    objectionCount: objs.length,
    suggestion: j.reviewSuggestion || '',
    reviewNote: j.reviewNote || '',
  };
};

// GET /api/team/review-stats/mine — the logged-in team member's OWN submissions.
// Powers the submitter's "how are my experiences doing" board.
const mine = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: { createdByTeamMemberId: req.teamMember.id },
    attributes: CARD_ATTRS,
    order: [['updatedAt', 'DESC']],
  });

  const hasObjections = (e) => objectionEntries(e.reviewSections).length > 0;
  const pendingReview = rows.filter((e) => e.status === 'pending_review');
  // "Follow-up" = sent back to me with objections to fix.
  const followUp = rows.filter((e) => e.status === 'draft' && (hasObjections(e) || e.reviewNote));
  const approved = rows.filter((e) => e.status === 'published');
  const rejected = rows.filter((e) => e.status === 'archived');
  const drafts = rows.filter((e) => e.status === 'draft' && !(hasObjections(e) || e.reviewNote));

  const followUpCards = followUp.map(card);
  const totalObjections = followUpCards.reduce((n, c) => n + c.objectionCount, 0);

  return ok(res, {
    totals: {
      all: rows.length,
      pendingReview: pendingReview.length,
      followUp: followUp.length,
      approved: approved.length,
      rejected: rejected.length,
      draft: drafts.length,
    },
    objections: {
      experiencesWithObjections: followUpCards.filter((c) => c.objectionCount > 0).length,
      total: totalObjections,
    },
    lists: {
      followUp: followUpCards,
      pendingReview: pendingReview.map(card),
      approved: approved.map(card),
      rejected: rejected.map(card),
    },
  });
});

// GET /api/team/review-stats/queue — Center Ops (or QCOPS) queue-wide board.
const queue = asyncHandler(async (req, res) => {
  const where = {
    [Op.or]: [
      { status: 'pending_review' },
      { status: 'draft', ownerUserId: { [Op.ne]: null } },
      { status: 'draft', supplierId: { [Op.ne]: null }, createdByTeamMemberId: null },
    ],
  };
  const isQcops = req.teamMember && req.teamMember.roleType === 'qcops';
  if (isQcops) where.qcopsTeamMemberId = req.teamMember.id;

  const candidates = await Experience.findAll({ where, attributes: CARD_ATTRS, order: [['updatedAt', 'DESC']] });
  const inQueue = candidates.filter(isReviewable);

  const followUp = inQueue.filter((e) => e.reviewStage === 'resubmitted');
  const fresh = inQueue.filter((e) => e.reviewStage !== 'resubmitted');
  const withQcops = inQueue.filter((e) => e.qcopsTeamMemberId);
  const objectionsRaised = inQueue.reduce((n, e) => n + objectionEntries(e.reviewSections).length, 0);

  // Approved / rejected outcomes (QCOPS sees only what they were assigned).
  const outcomeWhere = isQcops ? { qcopsTeamMemberId: req.teamMember.id } : {};
  const [approved, rejected] = await Promise.all([
    Experience.count({ where: { ...outcomeWhere, status: 'published', reviewStage: 'approved' } }),
    Experience.count({ where: { ...outcomeWhere, status: 'archived', reviewStage: 'rejected' } }),
  ]);

  return ok(res, {
    totals: {
      inQueue: inQueue.length,
      new: fresh.length,
      followUp: followUp.length,
      withQcops: withQcops.length,
      approved,
      rejected,
    },
    objectionsRaised,
    lists: {
      new: fresh.map(card),
      followUp: followUp.map(card),
    },
  });
});

module.exports = { mine, queue, myExperiences, mySuppliers, mySupplierExperiences };

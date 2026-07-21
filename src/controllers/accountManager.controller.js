const asyncHandler = require('express-async-handler');
const { Supplier, Experience, ExperienceCategory, ExperienceType } = require('../models');
const { ok, fail } = require('../utils/response');
const { submitterTab } = require('../utils/experienceStatus');

/*
  Everything an Account Manager sees is derived through `submitterTab` — the
  same single source of truth the BD and Center Ops boards use.

  This matters: a supplier's OWN submission never has `status:'pending_review'`
  (it rides the Host code path, which keeps `status:'draft'` and tracks
  progress on `reviewStage`). Counting raw `status` here used to make every
  supplier-portal listing invisible — the AM saw zeros and a "Draft" badge on
  a listing that was actually deep in the review pipeline.
*/
const TABS = ['in_queue', 'under_progress', 'live', 'rejected', 'delisted'];

// The signed-in Account Manager. Admin may call these routes too (staff auth),
// but has no portfolio of their own — they get an empty board, not a crash.
const amId = (req) => (req.teamMember ? req.teamMember.id : null);

// GET /api/team/my-suppliers — the signed-in Account Manager's assigned
// suppliers (round-robin assigned — see accountManager.service.js), each
// with a quick per-tab summary so the AM can tell who needs guidance right
// now without opening every supplier individually.
const mySuppliers = asyncHandler(async (req, res) => {
  const suppliers = await Supplier.findAll({
    where: { accountManagerId: amId(req) },
    order: [['companyName', 'ASC']],
  });

  const ids = suppliers.map((s) => s.id);
  const experiences = ids.length
    ? await Experience.findAll({
      where: { supplierId: ids },
      attributes: ['id', 'supplierId', 'status', 'isActive', 'reviewStage'],
    })
    : [];

  const items = suppliers.map((s) => {
    const own = experiences.filter((e) => e.supplierId === s.id);
    const stats = { total: own.length };
    TABS.forEach((t) => { stats[t] = own.filter((e) => submitterTab(e) === t).length; });
    return { ...s.toSafeJSON(), stats };
  });

  return ok(res, { items });
});

// Shape shared by the drill-down and the overview lists.
const cardOf = (e, supplier) => {
  const j = e.toJSON ? e.toJSON() : e;
  return {
    id: j.id,
    name: j.name,
    mainImage: j.mainImage,
    location: j.location || j.city || '',
    category: j.category?.name || null,
    type: j.type?.name || null,
    tab: submitterTab(j),
    status: j.status,
    reviewStage: j.reviewStage,
    isLive: j.status === 'published' && j.isActive,
    // Submitted by a BD rather than the supplier themselves. A BD owns their
    // own Under Progress rounds, so the AM must never be offered those.
    viaBd: !!j.createdByTeamMemberId,
    createdAt: j.createdAt,
    supplier: supplier
      ? { id: supplier.id, name: supplier.companyName, email: supplier.email, phone: supplier.phone, onboardedAt: supplier.createdAt }
      : null,
    listedAt: (j.data && j.data.listedAt) || null,
    delistedAt: (j.data && j.data.delistedAt) || null,
    reason: j.reviewNote || (j.data && j.data.delistReason) || null,
    // Everything the Under Progress responder UI needs — the same shape the
    // BD's board gets, so both render the identical block.
    qc: j.qcReview ? {
      status: j.qcReview.status || null,
      recommendation: j.qcReview.feedback?.recommendation || null,
      overallRating: j.qcReview.feedback?.overallRating || null,
      changeType: j.qcReview.changeType || null,
      changeDetails: j.qcReview.changeDetails || null,
      upState: j.qcReview.upState || null,
      upResponderId: j.qcReview.upResponderId || null,
      bdReason: j.qcReview.bdReason || null,
      bdDeadline: j.qcReview.bdDeadline || null,
      copsAck: j.qcReview.copsAck || null,
      supplierAck: j.qcReview.supplierAck || null,
    } : null,
  };
};

const INCLUDE = [
  { model: ExperienceCategory, as: 'category', attributes: ['id', 'name'] },
  { model: ExperienceType, as: 'type', attributes: ['id', 'name'] },
];

/*
  May THIS account manager answer the round on this card? Mirrors
  accountManager.service's mayRespondToUp, which is what the write endpoint
  enforces — if the two disagree the UI offers a button the API then rejects.

  `minesByDefault` covers an UNSTAMPED round: in the overview every card
  already belongs to one of my suppliers, so it's true there; the drill-down
  passes whether I actually manage that supplier.
*/
const respondableByAm = (card, me, minesByDefault) => {
  if (card.tab !== 'under_progress' || !me) return false;
  if (card.viaBd) return false; // a BD's own round is only theirs to answer
  const stamped = card.qc && card.qc.upResponderId;
  return stamped ? stamped === me : !!minesByDefault;
};

// GET /api/team/my-suppliers/:supplierId/experiences — every experience this
// assigned supplier has added, so the Account Manager can open each one's full
// details (incl. the QCOPS feedback) and actually help them.
const supplierExperiences = asyncHandler(async (req, res) => {
  const supplier = await Supplier.findByPk(req.params.supplierId);
  if (!supplier) return fail(res, 'Supplier not found', 404);
  // Admin sees any; an AM only their own assigned supplier.
  if (req.teamMember && supplier.accountManagerId !== req.teamMember.id) {
    return fail(res, 'This supplier is not assigned to you', 403);
  }

  const rows = await Experience.findAll({
    where: { supplierId: supplier.id },
    include: INCLUDE,
    order: [['updatedAt', 'DESC']],
  });

  const me = amId(req);
  const items = rows.map((r) => {
    const card = cardOf(r, supplier);
    // The AM answers the QCOPS changes round on a supplier's own submission —
    // so the drill-down carries the same respond block the listings tab has.
    card.canRespond = respondableByAm(card, me, supplier.accountManagerId === me);
    return card;
  });

  const counts = {};
  TABS.forEach((t) => { counts[t] = items.filter((i) => i.tab === t).length; });

  return ok(res, { supplier: supplier.toSafeJSON(), items, counts });
});

// GET /api/team/my-suppliers/overview — AM dashboard aggregates + drill-down
// lists, bucketed into the same five tabs the submitter boards use, each row
// carrying supplier + experience + onboarded/listed/delisted dates + reason.
const overview = asyncHandler(async (req, res) => {
  const me = amId(req);
  const suppliers = await Supplier.findAll({ where: { accountManagerId: me } });
  const supById = new Map(suppliers.map((s) => [s.id, s]));
  const ids = suppliers.map((s) => s.id);
  const exps = ids.length
    ? await Experience.findAll({
      where: { supplierId: ids },
      include: INCLUDE,
      order: [['updatedAt', 'DESC']],
    })
    : [];

  const cards = exps.map((e) => {
    const card = cardOf(e, supById.get(e.supplierId));
    // QCOPS asked for changes on a supplier's own submission — this AM now
    // owns the response (reject with reason / accept with a deadline), the job
    // a BD does for their own submissions. An unstamped round falls back to
    // whoever manages the supplier today, so it can never get stuck.
    card.canRespond = respondableByAm(card, me, true);
    return card;
  });

  const byTab = {};
  TABS.forEach((t) => { byTab[t] = cards.filter((c) => c.tab === t); });

  const actionNeeded = byTab.under_progress.filter((c) => c.canRespond && c.qc?.upState === 'pending_bd');

  return ok(res, {
    stats: {
      totalSuppliers: suppliers.length,
      totalListings: cards.length,
      inQueue: byTab.in_queue.length,
      underProgress: byTab.under_progress.length,
      actionNeeded: actionNeeded.length,
      liveListings: byTab.live.length,
      rejected: byTab.rejected.length,
      delisted: byTab.delisted.length,
    },
    // Legacy keys kept (live/rejected/delisted/under_progress) plus in_queue.
    ...byTab,
    actionNeeded,
  });
});

module.exports = { mySuppliers, supplierExperiences, overview };

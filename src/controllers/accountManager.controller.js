const asyncHandler = require('express-async-handler');
const { Supplier, Experience, ExperienceCategory, ExperienceType } = require('../models');
const { ok, fail } = require('../utils/response');

// GET /api/team/my-suppliers — the signed-in Account Manager's assigned
// suppliers (round-robin assigned — see accountManager.service.js), each
// with a quick experience-status summary so the AM can tell who needs
// guidance right now without opening every supplier individually.
const mySuppliers = asyncHandler(async (req, res) => {
  const suppliers = await Supplier.findAll({
    where: { accountManagerId: req.teamMember.id },
    order: [['companyName', 'ASC']],
  });

  const ids = suppliers.map((s) => s.id);
  const experiences = ids.length
    ? await Experience.findAll({ where: { supplierId: ids }, attributes: ['id', 'supplierId', 'status'] })
    : [];

  const items = suppliers.map((s) => {
    const own = experiences.filter((e) => e.supplierId === s.id);
    return {
      ...s.toSafeJSON(),
      stats: {
        total: own.length,
        pendingReview: own.filter((e) => e.status === 'pending_review').length,
        published: own.filter((e) => e.status === 'published').length,
        archived: own.filter((e) => e.status === 'archived').length,
      },
    };
  });

  return ok(res, { items });
});

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
    include: [
      { model: ExperienceCategory, as: 'category', attributes: ['id', 'name'] },
      { model: ExperienceType, as: 'type', attributes: ['id', 'name'] },
    ],
    order: [['updatedAt', 'DESC']],
  });

  const items = rows.map((r) => {
    const j = r.toJSON();
    return {
      id: j.id,
      name: j.name,
      mainImage: j.mainImage,
      location: j.location || j.city || '',
      status: j.status,
      reviewStage: j.reviewStage,
      isLive: j.status === 'published' && j.isActive,
      qc: j.qcReview ? { status: j.qcReview.status, recommendation: j.qcReview.feedback?.recommendation, overallRating: j.qcReview.feedback?.overallRating } : null,
      reviewNote: j.reviewNote || null,
    };
  });

  return ok(res, { supplier: supplier.toSafeJSON(), items });
});

// GET /api/team/my-suppliers/overview — AM dashboard aggregates + drill-down
// lists (live / rejected / delisted) across all assigned suppliers, each row
// carrying supplier + experience + onboarded/listed/delisted dates + reason.
const overview = asyncHandler(async (req, res) => {
  const suppliers = await Supplier.findAll({ where: { accountManagerId: req.teamMember.id } });
  const supById = new Map(suppliers.map((s) => [s.id, s]));
  const ids = suppliers.map((s) => s.id);
  const exps = ids.length
    ? await Experience.findAll({
      where: { supplierId: ids },
      include: [
        { model: ExperienceCategory, as: 'category', attributes: ['id', 'name'] },
        { model: ExperienceType, as: 'type', attributes: ['id', 'name'] },
      ],
      order: [['updatedAt', 'DESC']],
    })
    : [];

  const card = (e) => {
    const j = e.toJSON();
    const sup = supById.get(j.supplierId);
    return {
      id: j.id,
      name: j.name,
      mainImage: j.mainImage,
      location: j.location || j.city || '',
      category: j.category?.name || null,
      type: j.type?.name || null,
      supplier: sup ? { id: sup.id, name: sup.companyName, email: sup.email, phone: sup.phone, onboardedAt: sup.createdAt } : null,
      listedAt: (j.data && j.data.listedAt) || null,
      delistedAt: (j.data && j.data.delistedAt) || null,
      reason: j.reviewNote || (j.data && j.data.delistReason) || null,
      reviewStage: j.reviewStage,
      // Everything the Under Progress responder UI needs — the same shape the
      // BD's board gets, so both render the identical block.
      qc: j.qcReview ? {
        changeType: j.qcReview.changeType || null,
        changeDetails: j.qcReview.changeDetails || null,
        upState: j.qcReview.upState || null,
        bdReason: j.qcReview.bdReason || null,
        bdDeadline: j.qcReview.bdDeadline || null,
        copsAck: j.qcReview.copsAck || null,
        supplierAck: j.qcReview.supplierAck || null,
      } : null,
    };
  };

  const isLive = (e) => e.status === 'published' && e.isActive;
  const isRejected = (e) => ['rejected', 'qc_rejected'].includes(e.reviewStage) || (e.status === 'archived' && e.reviewStage !== 'delisted');
  const isDelisted = (e) => e.reviewStage === 'delisted';

  const live = exps.filter(isLive).map(card);
  const rejected = exps.filter(isRejected).map(card);
  const delisted = exps.filter(isDelisted).map(card);
  // QCOPS asked for changes on a supplier's own submission — this AM now owns
  // the response (reject with reason / accept with a deadline), the job a BD
  // does for their own submissions.
  const underProgress = exps
    .filter((e) => e.reviewStage === 'under_progress' && (e.qcReview || {}).upResponderId === req.teamMember.id)
    .map(card);

  return ok(res, {
    stats: {
      totalSuppliers: suppliers.length,
      liveListings: live.length,
      rejected: rejected.length,
      delisted: delisted.length,
      underProgress: underProgress.length,
    },
    live, rejected, delisted, under_progress: underProgress,
  });
});

module.exports = { mySuppliers, supplierExperiences, overview };

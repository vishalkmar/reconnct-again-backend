const asyncHandler = require('express-async-handler');
const { ExperienceCategory, Supplier, User, TeamMember } = require('../models');
const { ok, fail } = require('../utils/response');
const cm = require('../services/categoryManager.service');
const { submitterTab } = require('../utils/experienceStatus');
const { Experience, Review, Booking } = require('../models');
const { summarize } = require('../utils/reviewSections');
const { fromPaise } = require('../services/booking.service');
const { Op } = require('sequelize');

/*
  Category Manager dashboard — every endpoint is scoped to the categories THIS
  manager owns (ExperienceCategory.categoryManagerId === them). A non-CM (or a
  CM with no categories yet) simply sees an empty, honest board.

  Phase A ships the overview/summary; the eight deep modules (suppliers, status
  pipeline, ratings, revenue, onboardings, churn, delisted, win-back) build on
  the same scoping helper.
*/

// Guard: only a Category Manager may hit these.
const requireCm = (req, res) => {
  if (req.activeRole !== 'category_manager' && req.teamMember?.roleType !== 'category_manager') {
    fail(res, 'Not a Category Manager', 403);
    return false;
  }
  return true;
};

// GET /api/team/category/summary — the landing overview.
const summary = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const cats = catIds.length
    ? await ExperienceCategory.findAll({ where: { id: catIds }, attributes: ['id', 'name', 'slug'], order: [['sortOrder', 'ASC']] })
    : [];

  const exps = await cm.experiencesInCategories(catIds);
  let live = 0; let inReview = 0; let rejected = 0; let delisted = 0;
  const supplierIds = new Set();
  for (const e of exps) {
    const j = e.toJSON ? e.toJSON() : e;
    if (j.supplierId) supplierIds.add(j.supplierId);
    const tab = submitterTab(j);
    if (tab === 'live') live += 1;
    else if (tab === 'rejected') rejected += 1;
    else if (tab === 'delisted') delisted += 1;
    else inReview += 1;
  }

  return ok(res, {
    categories: cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
    stats: {
      categories: cats.length,
      experiences: exps.length,
      suppliers: supplierIds.size,
      live,
      inReview,
      rejected,
      delisted,
    },
  });
});

// GET /api/team/category/suppliers — every provider (supplier OR host) who has
// a listing in the categories this CM owns, with their full profile and the
// listings that put them in scope.
const suppliers = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exps = await cm.experiencesInCategories(catIds);

  // Group in-scope listings by their owner.
  const bySupplier = new Map();
  const byHost = new Map();
  for (const e of exps) {
    const j = e.toJSON ? e.toJSON() : e;
    const row = {
      id: j.id, name: j.name, status: submitterTab(j), rating: Number(j.rating) || 0,
      image: j.mainImage, city: j.city || j.location || null, createdAt: j.createdAt,
    };
    if (j.supplierId) (bySupplier.get(j.supplierId) || bySupplier.set(j.supplierId, []).get(j.supplierId)).push(row);
    else if (j.ownerUserId) (byHost.get(j.ownerUserId) || byHost.set(j.ownerUserId, []).get(j.ownerUserId)).push(row);
  }

  const supIds = [...bySupplier.keys()];
  const hostIds = [...byHost.keys()];
  const [sups, hosts] = await Promise.all([
    supIds.length ? Supplier.findAll({ where: { id: supIds } }) : [],
    hostIds.length ? User.findAll({ where: { id: hostIds }, attributes: ['id', 'name', 'email', 'phone', 'city', 'avatarUrl', 'createdAt', 'accountManagerId'] }) : [],
  ]);

  // Resolve each provider's Key Account Manager (name only).
  const kamIds = [...new Set([...sups.map((s2) => s2.accountManagerId), ...hosts.map((h) => h.accountManagerId)].filter(Boolean))];
  const kams = kamIds.length ? await TeamMember.findAll({ where: { id: kamIds }, attributes: ['id', 'name', 'email', 'phone'] }) : [];
  const kamById = new Map(kams.map((k) => [k.id, k]));
  const kamOf = (id) => (id && kamById.get(id)) ? { name: kamById.get(id).name, email: kamById.get(id).email, phone: kamById.get(id).phone } : null;

  const countLive = (list) => list.filter((l) => l.status === 'live').length;

  const providers = [
    ...sups.map((sp) => {
      const list = bySupplier.get(sp.id) || [];
      return {
        kind: 'supplier', id: sp.id,
        name: sp.companyName, contactName: sp.supplierName,
        email: sp.email, phone: sp.phone, image: sp.image, city: null,
        isActive: sp.isActive, createdAt: sp.createdAt,
        kam: kamOf(sp.accountManagerId),
        listings: list, total: list.length, live: countLive(list),
      };
    }),
    ...hosts.map((h) => {
      const list = byHost.get(h.id) || [];
      return {
        kind: 'host', id: h.id,
        name: h.name || h.email || 'Host', contactName: h.name,
        email: h.email, phone: h.phone, image: h.avatarUrl, city: h.city,
        isActive: true, createdAt: h.createdAt,
        kam: kamOf(h.accountManagerId),
        listings: list, total: list.length, live: countLive(list),
      };
    }),
  ].sort((a, b) => b.total - a.total);

  return ok(res, { providers });
});

// Human phase label from the review stage — the pipeline position an owner /
// CM cares about.
const PHASE = {
  submitted: { key: 'cops_review', label: 'Center Ops review' },
  in_review: { key: 'cops_review', label: 'Center Ops review' },
  resubmitted: { key: 'cops_review', label: 'Center Ops review (resubmitted)' },
  follow_up: { key: 'cops_review', label: 'Center Ops follow-up' },
  changes: { key: 'changes', label: 'Changes requested by Center Ops' },
  qc_assigned: { key: 'qcops', label: 'QCOPS visit assigned' },
  qc_acknowledged: { key: 'qcops', label: 'QCOPS scheduled the visit' },
  qc_onsite: { key: 'qcops', label: 'QCOPS on site' },
  qc_feedback: { key: 'qcops', label: 'QCOPS submitted feedback' },
  qc_passed: { key: 'qcops', label: 'Quality check passed — going live' },
  under_progress: { key: 'changes', label: 'Post-QC changes requested' },
  published: { key: 'live', label: 'Live on the platform' },
  live: { key: 'live', label: 'Live on the platform' },
  rejected: { key: 'rejected', label: 'Not approved' },
  qc_rejected: { key: 'rejected', label: 'Rejected after on-site check' },
  delisted: { key: 'delisted', label: 'Delisted' },
};
const phaseOf = (j) => PHASE[j.reviewStage] || (j.isPublished ? PHASE.live : { key: 'cops_review', label: 'In review' });

const providerName = async (j) => {
  if (j.supplierId) { const s2 = await Supplier.findByPk(j.supplierId, { attributes: ['companyName'] }); return s2?.companyName || 'Supplier'; }
  if (j.ownerUserId) { const u = await User.findByPk(j.ownerUserId, { attributes: ['name', 'email'] }); return u?.name || u?.email || 'Host'; }
  return 'BD-created';
};

// GET /api/team/category/status — every in-scope experience with its current
// pipeline phase and a compact review summary.
const status = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exps = await cm.experiencesInCategories(catIds);
  const items = await Promise.all(exps.map(async (e) => {
    const j = e.toJSON ? e.toJSON() : e;
    const sm = summarize(j);
    const ph = phaseOf(j);
    return {
      id: j.id,
      name: j.name,
      image: j.mainImage,
      provider: await providerName(j),
      providerKind: j.supplierId ? 'supplier' : j.ownerUserId ? 'host' : 'bd',
      tab: submitterTab(j),
      phaseKey: ph.key,
      phaseLabel: ph.label,
      stage: j.reviewStage || null,
      round: j.reviewRound || 0,
      sections: { total: sm.total, approved: sm.approved, objection: sm.objection, pending: sm.pending },
      rating: Number(j.rating) || 0,
      updatedAt: j.updatedAt,
    };
  }));
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return ok(res, { items });
});

// GET /api/team/category/status/:id — the FULL pipeline detail for one
// experience: submitter, every Center Ops section decision with its objection
// and the whole conversation, the QCOPS visit + feedback, and the final
// outcome. Scoped: 404 unless it's in one of this CM's categories.
const statusDetail = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exp = await Experience.findByPk(req.params.id);
  if (!exp) return fail(res, 'Not found', 404);
  const j = exp.toJSON();
  const inScope = (Array.isArray(j.categoryIds) ? j.categoryIds : []).some((id) => catIds.includes(Number(id)));
  if (!inScope) return fail(res, 'Not in your categories', 404);

  const sm = summarize(j);
  const ph = phaseOf(j);
  const qc = j.qcReview || {};

  // Names for the staff who touched it.
  const staffIds = [j.createdByTeamMemberId, qc.assignedByCopsId, qc.decidedByCopsId, j.qcopsTeamMemberId].filter(Boolean);
  const staff = staffIds.length ? await TeamMember.findAll({ where: { id: staffIds }, attributes: ['id', 'name', 'roleType'] }) : [];
  const staffById = new Map(staff.map((m) => [m.id, m]));
  const nm = (id) => (id && staffById.get(id)) ? staffById.get(id).name : null;

  return ok(res, {
    experience: {
      id: j.id, name: j.name, image: j.mainImage,
      provider: await providerName(j), providerKind: j.supplierId ? 'supplier' : j.ownerUserId ? 'host' : 'bd',
      phaseKey: ph.key, phaseLabel: ph.label, stage: j.reviewStage || null, round: j.reviewRound || 0,
      tab: submitterTab(j), rating: Number(j.rating) || 0,
      submittedByBd: nm(j.createdByTeamMemberId),
      suggestion: j.reviewSuggestion || '',
      reviewNote: j.reviewNote || '',
    },
    sections: { total: sm.total, approved: sm.approved, objection: sm.objection, pending: sm.pending, objections: sm.objections },
    thread: j.reviewThread || {},
    qc: {
      assignedBy: nm(qc.assignedByCopsId),
      qcops: nm(j.qcopsTeamMemberId),
      visitDate: qc.visitDate || null, visitTime: qc.visitTime || null,
      onsiteConfirmedAt: qc.onsiteConfirmedAt || null,
      feedback: qc.feedback || null,
      status: qc.status || null,
      changeType: qc.changeType || null, changeDetails: qc.changeDetails || null,
      deadline: qc.bdDeadline || null, decidedBy: nm(qc.decidedByCopsId),
    },
  });
});

// GET /api/team/category/reviews — every guest review for a listing in this
// CM's categories, plus the aggregates the charts need.
const reviews = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exps = await cm.experiencesInCategories(catIds, { attributes: ['id', 'name', 'categoryIds'] });
  const nameById = new Map(exps.map((e) => [e.id, e.name]));
  const expIds = exps.map((e) => e.id);
  if (!expIds.length) return ok(res, { summary: emptyReviewSummary(), reviews: [], byExperience: [] });

  const rows = await Review.findAll({
    where: { entityType: 'experience', entityId: expIds },
    order: [['createdAt', 'DESC']],
  });

  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const trend = new Map(); // 'YYYY-MM' -> { sum, n }
  const perExp = new Map(); // expId -> { sum, n }
  let sum = 0;
  const list = rows.map((r) => {
    const j = r.toJSON();
    dist[j.rating] = (dist[j.rating] || 0) + 1;
    sum += j.rating;
    const mk = String(j.createdAt).slice(0, 7);
    const t = trend.get(mk) || { sum: 0, n: 0 }; t.sum += j.rating; t.n += 1; trend.set(mk, t);
    const pe = perExp.get(j.entityId) || { sum: 0, n: 0 }; pe.sum += j.rating; pe.n += 1; perExp.set(j.entityId, pe);
    return {
      id: j.id, experienceId: j.entityId, experienceName: nameById.get(j.entityId) || 'Experience',
      name: j.name, rating: j.rating, title: j.title, comment: j.comment,
      isApproved: j.isApproved, createdAt: j.createdAt,
    };
  });

  return ok(res, {
    summary: {
      count: rows.length,
      average: rows.length ? Number((sum / rows.length).toFixed(2)) : 0,
      distribution: dist,
      trend: [...trend.entries()].sort().map(([month, v]) => ({ month, count: v.n, average: Number((v.sum / v.n).toFixed(2)) })),
    },
    reviews: list,
    byExperience: [...perExp.entries()]
      .map(([id, v]) => ({ experienceId: id, name: nameById.get(id) || 'Experience', count: v.n, average: Number((v.sum / v.n).toFixed(2)) }))
      .sort((a, b) => b.count - a.count),
  });
});
const emptyReviewSummary = () => ({ count: 0, average: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, trend: [] });

// GET /api/team/category/revenue — the full booking history for this CM's
// listings, as a daily series (with day-of-week for the weekend filters) plus
// per-listing totals. The frontend slices this into week/month/year, weekend
// vs weekday, and current-vs-previous comparisons — one fetch, every view.
const revenue = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exps = await cm.experiencesInCategories(catIds, { attributes: ['id', 'name', 'categoryIds'] });
  const nameById = new Map(exps.map((e) => [e.id, e.name]));
  const expIds = exps.map((e) => e.id);
  if (!expIds.length) return ok(res, { daily: [], byExperience: [], totals: { revenue: 0, bookings: 0 } });

  const rows = await Booking.findAll({
    where: {
      itemType: 'experience',
      itemId: { [Op.in]: expIds },
      status: { [Op.in]: ['confirmed', 'completed'] },
    },
    order: [['createdAt', 'ASC']],
  });

  const dayKey = (d) => {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const daily = new Map(); // 'YYYY-MM-DD' -> { revenue, bookings, dow }
  const perExp = new Map();
  let totalRev = 0;
  for (const b of rows) {
    const j = b.toJSON();
    // Revenue is booked on the day it was paid/created; the experience date is
    // separate. We key on booking date so "what came in this week" is honest.
    const when = j.paidAt || j.createdAt;
    const k = dayKey(when);
    const amt = fromPaise(j.subtotalPaise || 0);
    totalRev += amt;
    const d = daily.get(k) || { revenue: 0, bookings: 0, dow: new Date(when).getDay() };
    d.revenue += amt; d.bookings += 1; daily.set(k, d);
    const pe = perExp.get(j.itemId) || { revenue: 0, bookings: 0 };
    pe.revenue += amt; pe.bookings += 1; perExp.set(j.itemId, pe);
  }

  return ok(res, {
    daily: [...daily.entries()].sort().map(([date, v]) => ({ date, revenue: Math.round(v.revenue), bookings: v.bookings, dow: v.dow })),
    byExperience: [...perExp.entries()]
      .map(([id, v]) => ({ experienceId: id, name: nameById.get(id) || 'Experience', revenue: Math.round(v.revenue), bookings: v.bookings }))
      .sort((a, b) => b.revenue - a.revenue),
    totals: { revenue: Math.round(totalRev), bookings: rows.length },
  });
});

// Booking rollup (count + revenue) per experience id, for a set of ids.
const bookingRollup = async (expIds) => {
  const map = new Map();
  if (!expIds.length) return map;
  const rows = await Booking.findAll({
    where: { itemType: 'experience', itemId: { [Op.in]: expIds }, status: { [Op.in]: ['confirmed', 'completed'] } },
    attributes: ['itemId', 'subtotalPaise', 'userId'],
  });
  for (const b of rows) {
    const j = b.toJSON();
    const m = map.get(j.itemId) || { bookings: 0, revenue: 0, buyers: new Set() };
    m.bookings += 1; m.revenue += fromPaise(j.subtotalPaise || 0);
    if (j.userId) m.buyers.add(j.userId);
    map.set(j.itemId, m);
  }
  return map;
};

// GET /api/team/category/onboardings — everything LIVE in this CM's categories,
// with the numbers that matter: who provides it, when it went live, its rating,
// how many bookings and how much it's earned.
const onboardings = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exps = await cm.experiencesInCategories(catIds);
  const live = exps.filter((e) => submitterTab(e.toJSON ? e.toJSON() : e) === 'live');
  const roll = await bookingRollup(live.map((e) => e.id));
  const items = await Promise.all(live.map(async (e) => {
    const j = e.toJSON ? e.toJSON() : e;
    const r = roll.get(j.id) || { bookings: 0, revenue: 0, buyers: new Set() };
    return {
      id: j.id, name: j.name, image: j.mainImage,
      provider: await providerName(j), providerKind: j.supplierId ? 'supplier' : j.ownerUserId ? 'host' : 'bd',
      city: j.city || j.location || null,
      liveAt: (j.data && j.data.listedAt) || j.updatedAt,
      rating: Number(j.rating) || 0,
      bookings: r.bookings, buyers: r.buyers.size, revenue: Math.round(r.revenue),
    };
  }));
  items.sort((a, b) => b.revenue - a.revenue);
  return ok(res, { items });
});

// GET /api/team/category/delisted — listings taken down, with the reason. Click
// one → the status detail endpoint has the full trail (who said what, phases).
const delisted = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exps = await cm.experiencesInCategories(catIds);
  const gone = exps.filter((e) => submitterTab(e.toJSON ? e.toJSON() : e) === 'delisted');
  const items = await Promise.all(gone.map(async (e) => {
    const j = e.toJSON ? e.toJSON() : e;
    return {
      id: j.id, name: j.name, image: j.mainImage,
      provider: await providerName(j), providerKind: j.supplierId ? 'supplier' : j.ownerUserId ? 'host' : 'bd',
      reason: j.reviewNote || (j.qcReview && j.qcReview.changeDetails) || null,
      delistedAt: j.updatedAt,
    };
  }));
  items.sort((a, b) => String(b.delistedAt).localeCompare(String(a.delistedAt)));
  return ok(res, { items });
});

// GET /api/team/category/churn — best-effort churn view: providers who once
// listed in these categories but have NOTHING live now (all their in-scope
// listings are delisted/rejected, or their account is disabled). The formal
// churn signal isn't wired yet — this surfaces the drop-offs so the module and
// its emails are ready the moment it is.
const churn = asyncHandler(async (req, res) => {
  if (!requireCm(req, res)) return undefined;
  const catIds = await cm.ownedCategoryIds(req.teamMember.id);
  const exps = await cm.experiencesInCategories(catIds);
  const bySupplier = new Map();
  const byHost = new Map();
  for (const e of exps) {
    const j = e.toJSON ? e.toJSON() : e;
    const t = submitterTab(j);
    if (j.supplierId) { const m = bySupplier.get(j.supplierId) || { live: 0, total: 0, names: [] }; m.total += 1; if (t === 'live') m.live += 1; m.names.push(j.name); bySupplier.set(j.supplierId, m); }
    else if (j.ownerUserId) { const m = byHost.get(j.ownerUserId) || { live: 0, total: 0, names: [] }; m.total += 1; if (t === 'live') m.live += 1; m.names.push(j.name); byHost.set(j.ownerUserId, m); }
  }
  const supIds = [...bySupplier.keys()]; const hostIds = [...byHost.keys()];
  const [sups, hosts] = await Promise.all([
    supIds.length ? Supplier.findAll({ where: { id: supIds } }) : [],
    hostIds.length ? User.findAll({ where: { id: hostIds }, attributes: ['id', 'name', 'email', 'phone', 'isActive'] }) : [],
  ]);
  const items = [];
  for (const sp of sups) {
    const m = bySupplier.get(sp.id);
    if (m.live === 0 || !sp.isActive) items.push({ kind: 'supplier', id: sp.id, name: sp.companyName, email: sp.email, phone: sp.phone, isActive: sp.isActive, total: m.total, listings: m.names });
  }
  for (const h of hosts) {
    const m = byHost.get(h.id);
    if (m.live === 0 || !h.isActive) items.push({ kind: 'host', id: h.id, name: h.name || h.email, email: h.email, phone: h.phone, isActive: h.isActive, total: m.total, listings: m.names });
  }
  return ok(res, { items });
});

module.exports = { summary, suppliers, status, statusDetail, reviews, revenue, onboardings, delisted, churn };

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Review, Package, Event, Hotel, Experience, sequelize,
} = require('../models');
const { ok, created, fail } = require('../utils/response');

const ENTITY_TYPES = ['package', 'event', 'hotel', 'experience'];

// Each entity type maps to: the model that owns the rating fields, the
// public-listing image attribute, and the URL slug field used on the website.
const ENTITY_MAP = {
  package: { Model: Package, image: 'primaryImage', urlField: 'slug', publicPath: '/retreats' },
  event:   { Model: Event,   image: 'mainImage',    urlField: 'slug', publicPath: '/events' },
  hotel:   { Model: Hotel,   image: 'primaryImage', urlField: 'slug', publicPath: '/hotels' },
  experience: { Model: Experience, image: 'mainImage', urlField: 'slug', publicPath: '/experiences' },
};

const isValidType = (t) => ENTITY_TYPES.includes(t);

// Recompute rating + reviewCount for one entity from its approved reviews.
const recomputeStats = async (entityType, entityId) => {
  const stats = await Review.findAll({
    where: { entityType, entityId, isApproved: true },
    attributes: [
      [sequelize.fn('AVG', sequelize.col('rating')), 'avgRating'],
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
    ],
    raw: true,
  });
  const avg = parseFloat(stats[0]?.avgRating || 0);
  const cnt = parseInt(stats[0]?.count || 0, 10);
  const { Model } = ENTITY_MAP[entityType];
  if (!Model) return;
  await Model.update(
    { rating: avg.toFixed(2), reviewCount: cnt },
    { where: { id: entityId } }
  );
};

// Attach a thin entity snapshot (id, name, slug, image) onto each row so the
// admin UI can render a link/thumbnail without separate fetches.
const attachEntities = async (rows) => {
  // Group ids by entity type so we issue one query per type, regardless of how
  // many rows are mixed together.
  const buckets = {};
  rows.forEach((r) => {
    if (!buckets[r.entityType]) buckets[r.entityType] = new Set();
    buckets[r.entityType].add(r.entityId);
  });

  const lookup = {};
  for (const [type, idSet] of Object.entries(buckets)) {
    const map = ENTITY_MAP[type];
    if (!map) continue;
    const items = await map.Model.findAll({
      where: { id: { [Op.in]: [...idSet] } },
      attributes: ['id', 'name', map.urlField, map.image].filter(Boolean),
    });
    lookup[type] = new Map(items.map((it) => [it.id, it]));
  }

  return rows.map((r) => {
    const data = r.toJSON ? r.toJSON() : r;
    const map = ENTITY_MAP[data.entityType];
    const found = lookup[data.entityType]?.get(data.entityId);
    return {
      ...data,
      entity: found
        ? {
            id: found.id,
            name: found.name,
            slug: found[map.urlField],
            image: found[map.image],
            publicPath: map.publicPath,
          }
        : null,
    };
  });
};

// POST /api/reviews   (public)  — submit a new review for any entity
//   body: { entityType, entityId, name, email?, rating, title?, comment? }
const submit = asyncHandler(async (req, res) => {
  const { entityType, entityId, name, email, rating, title, comment } = req.body;
  if (!isValidType(entityType)) return fail(res, 'Invalid entityType', 400);
  if (!entityId) return fail(res, 'entityId is required', 400);
  if (!name?.trim()) return fail(res, 'Name is required', 400);
  if (!rating) return fail(res, 'Rating is required', 400);

  const { Model } = ENTITY_MAP[entityType];
  const target = await Model.findByPk(entityId);
  if (!target) return fail(res, `${entityType} not found`, 404);

  const review = await Review.create({
    entityType,
    entityId: parseInt(entityId, 10),
    name: name.trim(),
    email: email || null,
    rating: Math.max(1, Math.min(5, parseInt(rating, 10))),
    title: title || null,
    comment: comment || null,
    isApproved: false,
  });
  return created(res, { review }, 'Review submitted — pending approval');
});

// GET /api/reviews?entityType=...&entityId=...  (public — approved list)
const listForEntityPublic = asyncHandler(async (req, res) => {
  const { entityType, entityId, limit = 20 } = req.query;
  if (!isValidType(entityType)) return fail(res, 'Invalid entityType', 400);
  if (!entityId) return fail(res, 'entityId required', 400);

  const items = await Review.findAll({
    where: { entityType, entityId: parseInt(entityId, 10), isApproved: true },
    order: [['createdAt', 'DESC']],
    limit: Math.min(parseInt(limit, 10) || 20, 100),
  });
  return ok(res, { items });
});

// GET /api/reviews/featured  (public — latest approved reviews across all
// entity types, for homepage carousel)
const listFeaturedPublic = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 60);
  const { entityType } = req.query;
  const where = { isApproved: true };
  if (entityType && isValidType(entityType)) where.entityType = entityType;
  const rows = await Review.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  const items = await attachEntities(rows);
  return ok(res, { items });
});

// GET /api/reviews/admin?entityType=&status=&search=&page=&limit=  (admin)
const listAdmin = asyncHandler(async (req, res) => {
  const {
    entityType,
    status = 'pending',
    entityId,
    search,
    page = 1,
    limit = 20,
  } = req.query;

  const where = {};
  if (entityType && isValidType(entityType)) where.entityType = entityType;
  if (status === 'pending') where.isApproved = false;
  else if (status === 'approved') where.isApproved = true;
  if (entityId) where.entityId = parseInt(entityId, 10);
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { comment: { [Op.like]: `%${search}%` } },
      { title: { [Op.like]: `%${search}%` } },
    ];
  }

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const { rows, count } = await Review.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: parseInt(limit, 10),
    offset,
  });

  const items = await attachEntities(rows);

  // Per-type pending counts so the admin tabs can show badges at a glance.
  const pendingByType = {};
  for (const t of ENTITY_TYPES) {
    pendingByType[t] = await Review.count({
      where: { entityType: t, isApproved: false },
    });
  }

  return ok(res, {
    items,
    pendingByType,
    pendingCount: Object.values(pendingByType).reduce((a, b) => a + b, 0),
    pagination: {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      total: count,
      pages: Math.ceil(count / parseInt(limit, 10)),
    },
  });
});

// PATCH /api/reviews/:id/approve  (admin)
//   body: { approved?: boolean }  — when provided, sets explicitly (idempotent).
//   When omitted, falls back to toggling — kept for back-compat with older
//   clients. Idempotent set is the recommended path because it survives
//   rapid double-clicks / StrictMode re-fires without flipping the review
//   back to its prior state.
const toggleApprove = asyncHandler(async (req, res) => {
  const review = await Review.findByPk(req.params.id);
  if (!review) return fail(res, 'Review not found', 404);

  const next = typeof req.body?.approved === 'boolean'
    ? req.body.approved
    : !review.isApproved;

  // If the desired state already matches, skip the write + recompute entirely.
  // This keeps repeated calls truly idempotent.
  if (review.isApproved === next) {
    return ok(res, { review }, `Review already ${next ? 'approved' : 'pending'}`);
  }

  review.isApproved = next;
  await review.save();
  await recomputeStats(review.entityType, review.entityId);
  return ok(
    res,
    { review },
    `Review ${review.isApproved ? 'approved' : 'unapproved'}`
  );
});

// DELETE /api/reviews/:id  (admin)
const remove = asyncHandler(async (req, res) => {
  const review = await Review.findByPk(req.params.id);
  if (!review) return fail(res, 'Review not found', 404);
  const { entityType, entityId, isApproved } = review;
  await review.destroy();
  if (isApproved) await recomputeStats(entityType, entityId);
  return ok(res, {}, 'Review deleted');
});

module.exports = {
  submit,
  listForEntityPublic,
  listFeaturedPublic,
  listAdmin,
  toggleApprove,
  remove,
  recomputeStats,
  ENTITY_TYPES,
};

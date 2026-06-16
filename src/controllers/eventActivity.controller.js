const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const { EventActivity } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { normalizeGstRate } = require('../config/gst');

const CATEGORIES = EventActivity.CATEGORIES;

const parseJson = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
};

const ensureUniqueSlug = async (base, ignoreId = null) => {
  let slug = slugify(base || 'event', { lower: true, strict: true }) || `event-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (await EventActivity.findOne({
    where: { slug: candidate, ...(ignoreId && { id: { [Op.ne]: ignoreId } }) },
  })) {
    candidate = `${slug}-${i++}`;
    if (i > 100) break;
  }
  return candidate;
};

// Map an incoming body onto model fields. Used by create + update.
const COLUMN_STRINGS = [
  'subtitle', 'subCategory', 'activityType', 'status',
  'mainBanner', 'mobileBanner', 'thumbnail', 'youtubeUrl',
  'venueName', 'venueAddress', 'landmark', 'city', 'state', 'country', 'pincode', 'mapEmbed',
  'startTime', 'endTime', 'duration',
  'shortDescription', 'longDescription', 'highlights', 'whatMakesSpecial', 'inclusions', 'exclusions',
  'refundPolicy', 'cancellationPolicy', 'termsConditions',
  'hostName', 'hostBio', 'hostImage', 'hostInstagram', 'hostFacebook', 'hostWebsite',
  'metaTitle', 'metaDescription', 'currency',
];
const COLUMN_NUMBERS = ['latitude', 'longitude', 'adultPrice', 'childPrice', 'couplePrice', 'groupPrice', 'rating'];
const COLUMN_INTS = ['totalSeats', 'availableSeats', 'minParticipants', 'maxParticipants', 'sortOrder'];
const COLUMN_DATES = ['startDate', 'endDate'];
const COLUMN_BOOLS = ['isPaid', 'isActive', 'isFeatured'];
const COLUMN_JSON = ['audience', 'gallery', 'promoVideos', 'faqs', 'metaKeywords', 'testimonials', 'userImages', 'tickets', 'addons', 'categoryData', 'schedule'];

const applyBody = (row, body, { isCreate }) => {
  COLUMN_STRINGS.forEach((f) => {
    if (body[f] !== undefined) row[f] = body[f] === '' ? null : body[f];
  });
  COLUMN_NUMBERS.forEach((f) => {
    if (body[f] !== undefined) row[f] = body[f] === '' || body[f] === null ? null : parseFloat(body[f]);
  });
  COLUMN_INTS.forEach((f) => {
    if (body[f] !== undefined) row[f] = body[f] === '' || body[f] === null ? null : parseInt(body[f], 10);
  });
  COLUMN_DATES.forEach((f) => {
    if (body[f] !== undefined) row[f] = body[f] || null;
  });
  COLUMN_BOOLS.forEach((f) => {
    if (body[f] !== undefined) row[f] = body[f] === true || body[f] === 'true';
  });
  COLUMN_JSON.forEach((f) => {
    if (body[f] !== undefined) row[f] = parseJson(body[f], Array.isArray(row[f]) ? [] : {});
  });
  // GST applies globally to every price/ticket on this activity (0 = Off).
  if (body.gstRate !== undefined) row.gstRate = normalizeGstRate(body.gstRate);
  if (isCreate) {
    // sensible JSON defaults so columns never go null
    const objDefaults = new Set(['categoryData', 'schedule']);
    COLUMN_JSON.forEach((f) => { if (row[f] == null) row[f] = objDefaults.has(f) ? {} : []; });
  }
};

// ─── Public ──────────────────────────────────────────────────────────────

// GET /api/event-activities?category=&audience=&featured=&limit=&page=
const listPublic = asyncHandler(async (req, res) => {
  const { category, audience, featured, limit = 12, page = 1 } = req.query;
  const where = { isActive: true, status: 'published' };
  if (category && CATEGORIES.includes(category)) where.category = category;
  if (featured === 'true') where.isFeatured = true;

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  let { rows, count } = await EventActivity.findAndCountAll({
    where,
    order: [['sortOrder', 'ASC'], ['id', 'DESC']],
    limit: parseInt(limit, 10),
    offset,
  });

  // Audience is a JSON array — filter in JS (small lists, keeps SQL portable).
  if (audience) {
    rows = rows.filter((r) => Array.isArray(r.audience) && r.audience.includes(audience));
  }

  return ok(res, {
    items: rows,
    pagination: { page: parseInt(page, 10), limit: parseInt(limit, 10), total: count, pages: Math.ceil(count / parseInt(limit, 10)) },
  });
});

// GET /api/event-activities/:slug
const getBySlug = asyncHandler(async (req, res) => {
  const item = await EventActivity.findOne({ where: { slug: req.params.slug, isActive: true } });
  if (!item) return fail(res, 'Event not found', 404);
  return ok(res, { event: item });
});

// ─── Admin ───────────────────────────────────────────────────────────────

const listAdmin = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.category && CATEGORIES.includes(req.query.category)) where.category = req.query.category;
  if (req.query.status) where.status = req.query.status;
  const items = await EventActivity.findAll({ where, order: [['sortOrder', 'ASC'], ['id', 'DESC']] });
  return ok(res, { items });
});

const getAdminOne = asyncHandler(async (req, res) => {
  const item = await EventActivity.findByPk(req.params.id);
  if (!item) return fail(res, 'Event not found', 404);
  return ok(res, { event: item });
});

const create = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.title?.trim()) return fail(res, 'Title is required', 400);
  if (!CATEGORIES.includes(body.category)) return fail(res, 'A valid category is required', 400);

  const row = EventActivity.build({ title: body.title.trim(), category: body.category });
  row.slug = await ensureUniqueSlug(body.slug || body.title);
  applyBody(row, body, { isCreate: true });
  await row.save();
  return created(res, { event: row }, 'Event created');
});

const update = asyncHandler(async (req, res) => {
  const row = await EventActivity.findByPk(req.params.id);
  if (!row) return fail(res, 'Event not found', 404);
  const body = req.body || {};

  if (body.title !== undefined && body.title.trim()) row.title = body.title.trim();
  if (body.category !== undefined && CATEGORIES.includes(body.category)) row.category = body.category;
  if (body.slug !== undefined && body.slug !== row.slug) {
    row.slug = await ensureUniqueSlug(body.slug || row.title, row.id);
  }
  applyBody(row, body, { isCreate: false });
  await row.save();
  return ok(res, { event: row }, 'Event updated');
});

const toggle = asyncHandler(async (req, res) => {
  const row = await EventActivity.findByPk(req.params.id);
  if (!row) return fail(res, 'Event not found', 404);
  row.isActive = !row.isActive;
  await row.save();
  return ok(res, { event: row }, `Event ${row.isActive ? 'enabled' : 'disabled'}`);
});

const reorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => EventActivity.update({ sortOrder: idx }, { where: { id } })));
  return ok(res, {}, 'Reordered');
});

const remove = asyncHandler(async (req, res) => {
  const row = await EventActivity.findByPk(req.params.id);
  if (!row) return fail(res, 'Event not found', 404);
  await row.destroy();
  return ok(res, {}, 'Event deleted');
});

const duplicate = asyncHandler(async (req, res) => {
  const row = await EventActivity.findByPk(req.params.id);
  if (!row) return fail(res, 'Event not found', 404);
  const data = row.toJSON();
  ['id', 'createdAt', 'updatedAt'].forEach((k) => delete data[k]);
  data.title = `${data.title} (Copy)`;
  data.slug = await ensureUniqueSlug(`${data.slug}-copy`);
  data.status = 'draft';
  data.isActive = false;
  const copy = await EventActivity.create(data);
  return created(res, { event: copy }, 'Event duplicated');
});

module.exports = {
  listPublic,
  getBySlug,
  listAdmin,
  getAdminOne,
  create,
  update,
  toggle,
  reorder,
  remove,
  duplicate,
};

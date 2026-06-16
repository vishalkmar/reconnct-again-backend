const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, ExperienceAudience,
} = require('../models');
const { ok, created, fail } = require('../utils/response');

// Columns the form is allowed to write. Everything else the client sends is
// ignored (anything genuinely freeform should go inside `data`).
const WRITABLE = [
  'name', 'audiences', 'categoryId', 'typeId', 'location', 'city', 'nearbyLocation', 'latitude', 'longitude',
  'rating', 'about', 'mainImage', 'gallery', 'videos', 'mode', 'status',
  'priceMethod', 'pricing', 'currency', 'gstRate', 'tcsRate', 'discount',
  'termsConditions', 'privacyPolicy', 'refundPolicy', 'cancellationPolicy',
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
  return out;
};

const INCLUDE = [
  { model: ExperienceCategory, as: 'category', attributes: ['id', 'name', 'slug', 'icon', 'colorHex'] },
  { model: ExperienceType, as: 'type', attributes: ['id', 'name', 'slug', 'categoryId'] },
];

// Attach the hydrated audience objects (the row stores only their ids).
const withAudiences = async (exp) => {
  const j = exp.toJSON ? exp.toJSON() : exp;
  const ids = Array.isArray(j.audiences) ? j.audiences : [];
  if (ids.length) {
    const aud = await ExperienceAudience.findAll({ where: { id: ids } });
    j.audienceItems = aud.map((a) => ({ id: a.id, name: a.name, slug: a.slug, icon: a.icon }));
  } else {
    j.audienceItems = [];
  }
  return j;
};

// GET /api/experiences  (admin list)
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.categoryId) where.categoryId = parseInt(req.query.categoryId, 10);
  if (req.query.q) where.name = { [Op.like]: `%${req.query.q}%` };
  const items = await Experience.findAll({
    where,
    include: INCLUDE,
    order: [['sortOrder', 'ASC'], ['createdAt', 'DESC']],
  });
  return ok(res, { items });
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
  const item = await Experience.create(data);
  const full = await Experience.findByPk(item.id, { include: INCLUDE });
  return created(res, { item: await withAudiences(full) }, 'Experience saved');
});

// PUT /api/experiences/:id
const update = asyncHandler(async (req, res) => {
  const item = await Experience.findByPk(req.params.id);
  if (!item) return fail(res, 'Experience not found', 404);
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

module.exports = { list, getOne, create, update, duplicate, toggle, remove, reorder };

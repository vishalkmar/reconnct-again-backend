const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, ExperienceAudience, Supplier,
} = require('../models');
const { ok, created, fail } = require('../utils/response');

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
  { model: Supplier, as: 'supplier', attributes: ['id', 'companyName', 'supplierName', 'phone', 'email', 'image'] },
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

const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const { ExperienceAudience, ExperienceCategory, ExperienceType } = require('../models');
const { ok, created, fail } = require('../utils/response');

// ── slug helper (unique within an optional extra where-scope, e.g. categoryId)
const uniqueSlug = async (Model, base, { ignoreId = null, scope = {} } = {}) => {
  let root = slugify(String(base || ''), { lower: true, strict: true }) || `item-${Date.now()}`;
  let candidate = root;
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Model.findOne({
    where: { slug: candidate, ...scope, ...(ignoreId ? { id: { [Op.ne]: ignoreId } } : {}) },
  })) {
    candidate = `${root}-${i++}`;
    if (i > 60) break;
  }
  return candidate;
};

// ─────────────────────────── AUDIENCES (flat taxonomy) ─────────────────────
const listAudiences = asyncHandler(async (req, res) => {
  const where = req.query.all === 'true' ? {} : { isActive: true };
  const items = await ExperienceAudience.findAll({ where, order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
  return ok(res, { items });
});

const createAudience = asyncHandler(async (req, res) => {
  const { name, description, icon } = req.body;
  if (!name || !name.trim()) return fail(res, 'name is required', 400);
  const item = await ExperienceAudience.create({
    name: name.trim(),
    slug: await uniqueSlug(ExperienceAudience, req.body.slug || name),
    description: description || null,
    icon: icon || null,
    isCustom: req.body.isCustom === undefined ? true : !!req.body.isCustom,
    sortOrder: Number(req.body.sortOrder) || 0,
  });
  return created(res, { item }, 'Audience created');
});

const updateAudience = asyncHandler(async (req, res) => {
  const item = await ExperienceAudience.findByPk(req.params.id);
  if (!item) return fail(res, 'Audience not found', 404);
  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.slug !== undefined && req.body.slug !== item.slug) {
    item.slug = await uniqueSlug(ExperienceAudience, req.body.slug, { ignoreId: item.id });
  }
  if (req.body.description !== undefined) item.description = req.body.description || null;
  if (req.body.icon !== undefined) item.icon = req.body.icon || null;
  if (req.body.sortOrder !== undefined && req.body.sortOrder !== '') item.sortOrder = parseInt(req.body.sortOrder, 10);
  if (req.body.isActive !== undefined) item.isActive = req.body.isActive === true || req.body.isActive === 'true';
  await item.save();
  return ok(res, { item }, 'Audience updated');
});

const toggleAudience = asyncHandler(async (req, res) => {
  const item = await ExperienceAudience.findByPk(req.params.id);
  if (!item) return fail(res, 'Audience not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { item }, `Audience ${item.isActive ? 'enabled' : 'disabled'}`);
});

const removeAudience = asyncHandler(async (req, res) => {
  const item = await ExperienceAudience.findByPk(req.params.id);
  if (!item) return fail(res, 'Audience not found', 404);
  await item.destroy();
  return ok(res, {}, 'Audience deleted');
});

// ─────────────────────────── CATEGORIES (broad) ────────────────────────────
const listCategories = asyncHandler(async (req, res) => {
  const where = req.query.all === 'true' ? {} : { isActive: true };
  const items = await ExperienceCategory.findAll({
    where,
    order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    include: req.query.withTypes === 'true'
      ? [{ model: ExperienceType, as: 'types', required: false }]
      : [],
  });
  return ok(res, { items });
});

const createCategory = asyncHandler(async (req, res) => {
  const { name, description, icon, colorHex } = req.body;
  if (!name || !name.trim()) return fail(res, 'name is required', 400);
  const item = await ExperienceCategory.create({
    name: name.trim(),
    slug: await uniqueSlug(ExperienceCategory, req.body.slug || name),
    description: description || null,
    icon: icon || null,
    colorHex: colorHex || null,
    isCustom: req.body.isCustom === undefined ? true : !!req.body.isCustom,
    sortOrder: Number(req.body.sortOrder) || 0,
  });
  return created(res, { item }, 'Category created');
});

const updateCategory = asyncHandler(async (req, res) => {
  const item = await ExperienceCategory.findByPk(req.params.id);
  if (!item) return fail(res, 'Category not found', 404);
  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.slug !== undefined && req.body.slug !== item.slug) {
    item.slug = await uniqueSlug(ExperienceCategory, req.body.slug, { ignoreId: item.id });
  }
  if (req.body.description !== undefined) item.description = req.body.description || null;
  if (req.body.icon !== undefined) item.icon = req.body.icon || null;
  if (req.body.colorHex !== undefined) item.colorHex = req.body.colorHex || null;
  if (req.body.sortOrder !== undefined && req.body.sortOrder !== '') item.sortOrder = parseInt(req.body.sortOrder, 10);
  if (req.body.isActive !== undefined) item.isActive = req.body.isActive === true || req.body.isActive === 'true';
  await item.save();
  return ok(res, { item }, 'Category updated');
});

const toggleCategory = asyncHandler(async (req, res) => {
  const item = await ExperienceCategory.findByPk(req.params.id);
  if (!item) return fail(res, 'Category not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { item }, `Category ${item.isActive ? 'enabled' : 'disabled'}`);
});

const removeCategory = asyncHandler(async (req, res) => {
  const item = await ExperienceCategory.findByPk(req.params.id);
  if (!item) return fail(res, 'Category not found', 404);
  await item.destroy(); // CASCADE removes its types
  return ok(res, {}, 'Category deleted');
});

// ─────────────────────────── TYPES (under a category) ──────────────────────
const listTypes = asyncHandler(async (req, res) => {
  const where = req.query.all === 'true' ? {} : { isActive: true };
  if (req.query.categoryId) where.categoryId = parseInt(req.query.categoryId, 10);
  const items = await ExperienceType.findAll({ where, order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
  return ok(res, { items });
});

const createType = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const categoryId = parseInt(req.body.categoryId, 10);
  if (!name || !name.trim()) return fail(res, 'name is required', 400);
  if (!Number.isInteger(categoryId)) return fail(res, 'categoryId is required', 400);
  const cat = await ExperienceCategory.findByPk(categoryId);
  if (!cat) return fail(res, 'Parent category not found', 404);
  const item = await ExperienceType.create({
    categoryId,
    name: name.trim(),
    slug: await uniqueSlug(ExperienceType, req.body.slug || name, { scope: { categoryId } }),
    description: description || null,
    isCustom: req.body.isCustom === undefined ? true : !!req.body.isCustom,
    sortOrder: Number(req.body.sortOrder) || 0,
  });
  return created(res, { item }, 'Type created');
});

const updateType = asyncHandler(async (req, res) => {
  const item = await ExperienceType.findByPk(req.params.id);
  if (!item) return fail(res, 'Type not found', 404);
  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.slug !== undefined && req.body.slug !== item.slug) {
    item.slug = await uniqueSlug(ExperienceType, req.body.slug, { ignoreId: item.id, scope: { categoryId: item.categoryId } });
  }
  if (req.body.description !== undefined) item.description = req.body.description || null;
  if (req.body.sortOrder !== undefined && req.body.sortOrder !== '') item.sortOrder = parseInt(req.body.sortOrder, 10);
  if (req.body.isActive !== undefined) item.isActive = req.body.isActive === true || req.body.isActive === 'true';
  await item.save();
  return ok(res, { item }, 'Type updated');
});

const toggleType = asyncHandler(async (req, res) => {
  const item = await ExperienceType.findByPk(req.params.id);
  if (!item) return fail(res, 'Type not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { item }, `Type ${item.isActive ? 'enabled' : 'disabled'}`);
});

const removeType = asyncHandler(async (req, res) => {
  const item = await ExperienceType.findByPk(req.params.id);
  if (!item) return fail(res, 'Type not found', 404);
  await item.destroy();
  return ok(res, {}, 'Type deleted');
});

module.exports = {
  listAudiences, createAudience, updateAudience, toggleAudience, removeAudience,
  listCategories, createCategory, updateCategory, toggleCategory, removeCategory,
  listTypes, createType, updateType, toggleType, removeType,
};

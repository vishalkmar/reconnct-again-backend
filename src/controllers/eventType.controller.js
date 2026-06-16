const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const { EventType } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const ensureUniqueSlug = async (base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `event-type-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (
    await EventType.findOne({
      where: { slug: candidate, ...(ignoreId && { id: { [Op.ne]: ignoreId } }) },
    })
  ) {
    candidate = `${slug}-${i++}`;
    if (i > 50) break;
  }
  return candidate;
};

const parseBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

const listPublic = asyncHandler(async (req, res) => {
  const items = await EventType.findAll({
    where: { isActive: true },
    order: [['sortOrder', 'ASC'], ['name', 'ASC']],
  });
  return ok(res, { items });
});

const listAll = asyncHandler(async (req, res) => {
  const items = await EventType.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
  return ok(res, { items });
});

const getOne = asyncHandler(async (req, res) => {
  const item = await EventType.findByPk(req.params.id);
  if (!item) return fail(res, 'Event type not found', 404);
  return ok(res, { item });
});

const create = asyncHandler(async (req, res) => {
  const { name, description, sortOrder, isActive, isSport } = req.body;
  if (!name) {
    if (req.file) removeUploadedFile(getUploadedUrl(req.file));
    return fail(res, 'name is required', 400);
  }

  const item = await EventType.create({
    name,
    slug: await ensureUniqueSlug(req.body.slug || name),
    description: description || null,
    sortOrder: sortOrder !== undefined && sortOrder !== '' ? parseInt(sortOrder, 10) : 0,
    isActive: isActive === 'false' ? false : true,
    isSport: parseBool(isSport),
    imageUrl: req.file ? getUploadedUrl(req.file) : null,
  });
  return created(res, { item }, 'Event type created');
});

const update = asyncHandler(async (req, res) => {
  const item = await EventType.findByPk(req.params.id);
  if (!item) {
    if (req.file) removeUploadedFile(getUploadedUrl(req.file));
    return fail(res, 'Event type not found', 404);
  }

  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.slug !== undefined && req.body.slug !== item.slug) {
    item.slug = await ensureUniqueSlug(req.body.slug, item.id);
  }
  if (req.body.description !== undefined) item.description = req.body.description || null;
  if (req.body.sortOrder !== undefined && req.body.sortOrder !== '')
    item.sortOrder = parseInt(req.body.sortOrder, 10);
  if (req.body.isActive !== undefined)
    item.isActive = req.body.isActive === 'true' || req.body.isActive === true;
  if (req.body.isSport !== undefined) item.isSport = parseBool(req.body.isSport);

  if (req.file) {
    if (item.imageUrl) removeUploadedFile(item.imageUrl);
    item.imageUrl = getUploadedUrl(req.file);
  }

  await item.save();
  return ok(res, { item }, 'Event type updated');
});

const toggle = asyncHandler(async (req, res) => {
  const item = await EventType.findByPk(req.params.id);
  if (!item) return fail(res, 'Event type not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { item }, `Event type ${item.isActive ? 'enabled' : 'disabled'}`);
});

const remove = asyncHandler(async (req, res) => {
  const item = await EventType.findByPk(req.params.id);
  if (!item) return fail(res, 'Event type not found', 404);
  if (item.imageUrl) removeUploadedFile(item.imageUrl);
  await item.destroy();
  return ok(res, {}, 'Event type deleted');
});

const reorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => EventType.update({ sortOrder: idx }, { where: { id } })));
  const items = await EventType.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
  return ok(res, { items }, 'Reordered');
});

module.exports = { listPublic, listAll, getOne, create, update, toggle, remove, reorder };

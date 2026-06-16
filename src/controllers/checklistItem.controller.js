const asyncHandler = require('express-async-handler');
const { ChecklistItem } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

// GET /api/checklist  (public — active items only)
const listPublic = asyncHandler(async (req, res) => {
  const items = await ChecklistItem.findAll({
    where: { isActive: true },
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  return ok(res, { items });
});

// GET /api/checklist/admin/all
const listAdmin = asyncHandler(async (req, res) => {
  const items = await ChecklistItem.findAll({
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  return ok(res, { items });
});

// GET /api/checklist/admin/:id
const getAdminOne = asyncHandler(async (req, res) => {
  const item = await ChecklistItem.findByPk(req.params.id);
  if (!item) return fail(res, 'Item not found', 404);
  return ok(res, { item });
});

// POST /api/checklist  (admin)
const createItem = asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body.label?.trim()) return fail(res, 'label is required', 400);
  const iconFile = req.files?.icon?.[0];

  const item = await ChecklistItem.create({
    label: body.label,
    description: body.description || null,
    iconName: body.iconName || null,
    iconUrl: iconFile ? buildUrl(iconFile) : null,
    sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
    isActive: body.isActive === 'false' ? false : true,
  });
  return created(res, { item }, 'Checklist item created');
});

// PUT /api/checklist/:id  (admin)
const updateItem = asyncHandler(async (req, res) => {
  const item = await ChecklistItem.findByPk(req.params.id);
  if (!item) return fail(res, 'Item not found', 404);

  const body = req.body;
  const iconFile = req.files?.icon?.[0];

  if (body.label !== undefined) item.label = body.label;
  if (body.description !== undefined) item.description = body.description === '' ? null : body.description;
  if (body.iconName !== undefined) item.iconName = body.iconName === '' ? null : body.iconName;
  if (body.sortOrder !== undefined && body.sortOrder !== '') item.sortOrder = parseInt(body.sortOrder, 10);
  if (body.isActive !== undefined) item.isActive = body.isActive === 'true' || body.isActive === true;

  if (iconFile) {
    if (item.iconUrl) removeFileIfLocal(item.iconUrl);
    item.iconUrl = buildUrl(iconFile);
  } else if (body.clearIconUrl === 'true') {
    if (item.iconUrl) removeFileIfLocal(item.iconUrl);
    item.iconUrl = null;
  }

  await item.save();
  return ok(res, { item }, 'Checklist item updated');
});

// PATCH /api/checklist/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const item = await ChecklistItem.findByPk(req.params.id);
  if (!item) return fail(res, 'Item not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { item }, `Item ${item.isActive ? 'enabled' : 'disabled'}`);
});

// PUT /api/checklist/admin/reorder  body: { order: [id, id, …] }
const reorderItems = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => ChecklistItem.update({ sortOrder: idx }, { where: { id } })));
  return ok(res, {}, 'Reordered');
});

// DELETE /api/checklist/:id
const removeItem = asyncHandler(async (req, res) => {
  const item = await ChecklistItem.findByPk(req.params.id);
  if (!item) return fail(res, 'Item not found', 404);
  if (item.iconUrl) removeFileIfLocal(item.iconUrl);
  await item.destroy();
  return ok(res, {}, 'Item deleted');
});

module.exports = {
  listPublic,
  listAdmin,
  getAdminOne,
  createItem,
  updateItem,
  toggle,
  reorderItems,
  removeItem,
};

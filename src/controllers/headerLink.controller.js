const asyncHandler = require('express-async-handler');
const { HeaderLink } = require('../models');
const { ok, created, fail } = require('../utils/response');

// GET /api/header-links  (public — only active)
const listPublic = asyncHandler(async (req, res) => {
  const links = await HeaderLink.findAll({
    where: { isActive: true },
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  return ok(res, { links });
});

// GET /api/header-links/all  (admin — all)
const listAll = asyncHandler(async (req, res) => {
  const links = await HeaderLink.findAll({
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  return ok(res, { links });
});

// POST /api/header-links
const createLink = asyncHandler(async (req, res) => {
  const { label, path, target, icon, sortOrder, isActive } = req.body;
  if (!label || !path) return fail(res, 'label and path are required', 400);

  const link = await HeaderLink.create({
    label,
    path,
    target: target || '_self',
    icon: icon || null,
    sortOrder: sortOrder !== undefined ? parseInt(sortOrder, 10) : 0,
    isActive: isActive !== undefined ? isActive : true,
  });
  return created(res, { link }, 'Header link created');
});

// PUT /api/header-links/:id
const updateLink = asyncHandler(async (req, res) => {
  const link = await HeaderLink.findByPk(req.params.id);
  if (!link) return fail(res, 'Link not found', 404);

  ['label', 'path', 'target', 'icon'].forEach((f) => {
    if (req.body[f] !== undefined) link[f] = req.body[f] === '' ? null : req.body[f];
  });
  if (req.body.sortOrder !== undefined) link.sortOrder = parseInt(req.body.sortOrder, 10);
  if (req.body.isActive !== undefined) link.isActive = !!req.body.isActive;

  await link.save();
  return ok(res, { link }, 'Header link updated');
});

// PATCH /api/header-links/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const link = await HeaderLink.findByPk(req.params.id);
  if (!link) return fail(res, 'Link not found', 404);
  link.isActive = !link.isActive;
  await link.save();
  return ok(res, { link }, `Link ${link.isActive ? 'enabled' : 'disabled'}`);
});

// PUT /api/header-links/reorder  body: { order: [id, id, id...] }
const reorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);

  await Promise.all(
    order.map((id, idx) => HeaderLink.update({ sortOrder: idx }, { where: { id } }))
  );

  const links = await HeaderLink.findAll({
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  return ok(res, { links }, 'Reordered');
});

// DELETE /api/header-links/:id
const deleteLink = asyncHandler(async (req, res) => {
  const link = await HeaderLink.findByPk(req.params.id);
  if (!link) return fail(res, 'Link not found', 404);
  await link.destroy();
  return ok(res, {}, 'Header link deleted');
});

module.exports = { listPublic, listAll, createLink, updateLink, toggle, reorder, deleteLink };

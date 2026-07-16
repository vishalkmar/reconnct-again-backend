const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { Supplier, Experience } = require('../models');
const { ok, created, fail } = require('../utils/response');

const WRITABLE = ['companyName', 'supplierName', 'phone', 'email', 'image', 'b2bContract', 'notes', 'isActive', 'sortOrder'];

const pickWritable = (body) => {
  const out = {};
  for (const k of WRITABLE) if (k in body) out[k] = body[k];
  // Only ever set when explicitly provided (and non-empty) — never blanks an
  // existing password out via a normal partial update.
  if (body.password) out.password = String(body.password);
  return out;
};

// GET /api/suppliers
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.q) where.companyName = { [Op.like]: `%${req.query.q}%` };
  if (req.query.active === 'true') where.isActive = true;
  const items = await Supplier.findAll({ where, order: [['sortOrder', 'ASC'], ['companyName', 'ASC']] });
  return ok(res, { items: items.map((i) => i.toSafeJSON()) });
});

// GET /api/suppliers/:id
const getOne = asyncHandler(async (req, res) => {
  const item = await Supplier.findByPk(req.params.id);
  if (!item) return fail(res, 'Supplier not found', 404);
  return ok(res, { item: item.toSafeJSON() });
});

// POST /api/suppliers
const create = asyncHandler(async (req, res) => {
  const data = pickWritable(req.body);
  if (!data.companyName || !String(data.companyName).trim()) return fail(res, 'Company name is required', 400);
  // Tagged so Center Ops / Account Manager can tell a BD-onboarded supplier
  // apart from one the admin added directly. Untouched for admin requests.
  if (req.teamMember) data.createdByTeamMemberId = req.teamMember.id;
  const item = await Supplier.create(data);
  return created(res, { item: item.toSafeJSON() }, 'Supplier created');
});

// PUT /api/suppliers/:id
const update = asyncHandler(async (req, res) => {
  const item = await Supplier.findByPk(req.params.id);
  if (!item) return fail(res, 'Supplier not found', 404);
  await item.update(pickWritable(req.body));
  return ok(res, { item: item.toSafeJSON() }, 'Supplier updated');
});

// PATCH /api/suppliers/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const item = await Supplier.findByPk(req.params.id);
  if (!item) return fail(res, 'Supplier not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { item: item.toSafeJSON() }, `Supplier ${item.isActive ? 'enabled' : 'disabled'}`);
});

// DELETE /api/suppliers/:id  — detaches experiences (supplierId → null via SET NULL).
const remove = asyncHandler(async (req, res) => {
  const item = await Supplier.findByPk(req.params.id);
  if (!item) return fail(res, 'Supplier not found', 404);
  const count = await Experience.count({ where: { supplierId: item.id } });
  await item.destroy();
  return ok(res, { detached: count }, count ? `Supplier deleted; ${count} experience(s) detached` : 'Supplier deleted');
});

module.exports = { list, getOne, create, update, toggle, remove };

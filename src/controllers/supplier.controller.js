const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { Supplier, Experience } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { generatePassword, sendSupplierWelcome } = require('../services/supplierWelcome.service');

// `notes` deliberately dropped — the field was removed from the onboarding form.
const WRITABLE = ['companyName', 'supplierName', 'phone', 'email', 'image', 'b2bContract', 'isActive', 'sortOrder'];

const pickWritable = (body) => {
  const out = {};
  for (const k of WRITABLE) if (k in body) out[k] = body[k];
  // Only ever set when explicitly provided (and non-empty) — never blanks an
  // existing password out via a normal partial update.
  if (body.password) out.password = String(body.password);
  return out;
};

// GET /api/suppliers — a team member (BD) only ever sees suppliers THEY
// onboarded, everywhere this list is consumed (My Suppliers tab, the
// Experience form's supplier picker, etc.); the admin still sees all of them.
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.q) where.companyName = { [Op.like]: `%${req.query.q}%` };
  if (req.query.active === 'true') where.isActive = true;
  if (req.teamMember) where.createdByTeamMemberId = req.teamMember.id;
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
  const need = (v) => !!(v && String(v).trim());
  if (!need(data.companyName)) return fail(res, 'Company name is required', 400);
  if (!need(data.supplierName)) return fail(res, 'Supplier name is required', 400);
  if (!need(data.phone)) return fail(res, 'Phone is required', 400);
  if (!need(data.email)) return fail(res, 'Email is required — the supplier logs in with it', 400);

  // Email IS the supplier's login (supplierAuth lower-cases it on the way in),
  // so it must be unique — store it normalised and reject a duplicate up front
  // rather than minting a second account nobody can sign into.
  data.email = String(data.email).toLowerCase().trim();
  const clash = await Supplier.findOne({ where: { email: data.email } });
  if (clash) return fail(res, 'A supplier with this email already exists', 409);

  /*
    Round-robin gate — a supplier is useless without a Key Account Manager, and
    a KAM is assigned the moment their first listing goes live. If every KAM is
    already at their cap (and un-assigned suppliers already fill the remaining
    slots), this new supplier could never get one. Refuse the creation up front
    with a clear, actionable message instead of quietly orphaning them. Admin
    raises a KAM's limit (or adds a KAM) in "KAM Accounts Management".
  */
  const { kamCapacity } = require('../services/accountManager.service'); // eslint-disable-line global-require
  const cap = await kamCapacity();
  if (!cap.ok) {
    const msg = cap.managers === 0
      ? 'No Account Manager (KAM) exists yet — a supplier can\'t be onboarded until one is set up. Please ask an admin to add a KAM.'
      : 'All Account Managers (KAMs) are at their supplier limit, so this supplier can\'t be assigned one. Please ask an admin to raise a KAM\'s limit or add a new KAM.';
    return fail(res, msg, 409, { code: 'KAM_CAPACITY_FULL' });
  }

  /*
    The password is generated HERE, never supplied by whoever is filling the
    form: the person onboarding a supplier has no business knowing their
    login. It's hashed by the model hook, and the plaintext only ever leaves
    this function inside the welcome email — never in the response.
  */
  const password = generatePassword();
  data.password = password;

  // Tagged so Center Ops / Account Manager can tell a BD-onboarded supplier
  // apart from one the admin added directly. Untouched for admin requests.
  if (req.teamMember) data.createdByTeamMemberId = req.teamMember.id;
  const item = await Supplier.create(data);

  // Non-blocking: the account exists either way, and a failed mail shouldn't
  // roll back onboarding — but it IS the only copy of the password, so log it.
  sendSupplierWelcome({ supplier: item, password })
    .catch((err) => console.error('[supplier] welcome email failed:', err.message));

  return created(res, { item: item.toSafeJSON() }, 'Supplier created — login details emailed to them');
});

// PUT /api/suppliers/:id
const update = asyncHandler(async (req, res) => {
  const item = await Supplier.findByPk(req.params.id);
  if (!item) return fail(res, 'Supplier not found', 404);
  const data = pickWritable(req.body);
  // Changing the login email → keep it normalised and still unique across
  // every OTHER supplier.
  if (data.email !== undefined) {
    data.email = String(data.email).toLowerCase().trim();
    const clash = await Supplier.findOne({ where: { email: data.email, id: { [Op.ne]: item.id } } });
    if (clash) return fail(res, 'Another supplier already uses this email', 409);
  }
  await item.update(data);
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

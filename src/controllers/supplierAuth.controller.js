const asyncHandler = require('express-async-handler');
const { Supplier } = require('../models');
const { signToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');

// POST /api/supplier/auth/login  { email, password }
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 'Email and password are required', 400);

  const supplier = await Supplier.findOne({ where: { email: String(email).toLowerCase().trim() } });
  if (!supplier || !supplier.isActive) return fail(res, 'Invalid credentials', 401);

  const matches = await supplier.comparePassword(password);
  if (!matches) return fail(res, 'Invalid credentials', 401);

  supplier.lastLoginAt = new Date();
  await supplier.save();

  const token = signToken({ id: supplier.id, kind: 'supplier' });
  return ok(res, { token, supplier: supplier.toSafeJSON() }, 'Logged in');
});

// GET /api/supplier/auth/me
const me = asyncHandler(async (req, res) => ok(res, { supplier: req.supplier.toSafeJSON() }));

module.exports = { login, me };

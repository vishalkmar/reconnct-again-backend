const asyncHandler = require('express-async-handler');
const { Admin } = require('../models');
const { signToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 'Email and password are required', 400);

  const admin = await Admin.findOne({ where: { email: email.toLowerCase().trim() } });
  if (!admin || !admin.isActive) return fail(res, 'Invalid credentials', 401);

  const matches = await admin.comparePassword(password);
  if (!matches) return fail(res, 'Invalid credentials', 401);

  admin.lastLoginAt = new Date();
  await admin.save();

  const token = signToken({ id: admin.id, role: admin.role });
  return ok(res, { token, admin: admin.toSafeJSON() }, 'Logged in');
});

// GET /api/auth/me
const me = asyncHandler(async (req, res) => ok(res, { admin: req.admin.toSafeJSON() }));

// POST /api/auth/change-password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return fail(res, 'Both passwords are required', 400);
  if (newPassword.length < 8) return fail(res, 'New password must be at least 8 characters', 400);

  const matches = await req.admin.comparePassword(currentPassword);
  if (!matches) return fail(res, 'Current password is wrong', 400);

  req.admin.password = newPassword;
  await req.admin.save();
  return ok(res, {}, 'Password updated');
});

module.exports = { login, me, changePassword };

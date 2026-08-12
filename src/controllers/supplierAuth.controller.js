const asyncHandler = require('express-async-handler');
const { Supplier } = require('../models');
const { signToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');
const {
  makeToken, hashToken, resetUrl, sendResetEmail, sendResetDoneEmail,
} = require('../services/passwordReset.service');

// POST /api/supplier/auth/login  { email, password }
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 'Email and password are required', 400);

  const supplier = await Supplier.findOne({ where: { email: String(email).toLowerCase().trim() } });
  if (!supplier) return fail(res, 'Invalid credentials', 401);

  const matches = await supplier.comparePassword(password);
  if (!matches) return fail(res, 'Invalid credentials', 401);

  // Correct credentials but the account is disabled — say so clearly instead of
  // the misleading "Invalid credentials" (only after the password check, so a
  // disabled account isn't revealed to someone who doesn't know the password).
  if (!supplier.isActive) return fail(res, 'This supplier account is disabled. Please contact your account manager or admin to re-enable it.', 403);

  supplier.lastLoginAt = new Date();
  await supplier.save();

  const token = signToken({ id: supplier.id, kind: 'supplier' });
  return ok(res, { token, supplier: supplier.toSafeJSON() }, 'Logged in');
});

// GET /api/supplier/auth/me
const me = asyncHandler(async (req, res) => ok(res, { supplier: req.supplier.toSafeJSON() }));

// POST /api/supplier/auth/forgot-password  { email }
const forgotPassword = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!email) return fail(res, 'Email is required', 400);
  const supplier = await Supplier.findOne({ where: { email } });
  if (supplier && supplier.isActive) {
    const { raw, hash, expires } = makeToken();
    supplier.passwordResetToken = hash;
    supplier.passwordResetExpires = expires;
    await supplier.save();
    sendResetEmail({
      to: email, name: supplier.companyName || supplier.supplierName, url: resetUrl('supplier', email, raw), roleLabel: 'Supplier account',
    }).catch((e) => console.error('[supplier forgot-password] mail failed:', e.message));
  }
  return ok(res, {}, 'If that email is registered, a password-reset link is on its way.');
});

// POST /api/supplier/auth/reset-password  { email, token, password }
const resetPassword = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!email || !token || !password) return fail(res, 'Email, token and new password are required', 400);
  if (password.length < 6) return fail(res, 'Password must be at least 6 characters', 400);
  // Token-only lookup + JS expiry check (SQL DATETIME comparison is timezone-
  // skew prone, which was making fresh links look "expired").
  const supplier = await Supplier.findOne({
    where: { email, passwordResetToken: hashToken(token) },
  });
  if (!supplier) return fail(res, 'This reset link is invalid or has already been used. Please request a new one.', 400);
  const expiresAt = supplier.passwordResetExpires ? new Date(supplier.passwordResetExpires).getTime() : 0;
  if (!expiresAt || expiresAt < Date.now()) return fail(res, 'This reset link has expired. Please request a new one.', 400);
  supplier.password = password; // model hook re-hashes
  supplier.passwordResetToken = null;
  supplier.passwordResetExpires = null;
  await supplier.save();
  sendResetDoneEmail({
    to: email, name: supplier.companyName || supplier.supplierName, roleLabel: 'Supplier account', portal: 'supplier',
  }).catch((e) => console.error('[supplier reset-done] mail failed:', e.message));
  return ok(res, {}, 'Your password has been reset. You can now sign in.');
});

module.exports = {
  login, me, forgotPassword, resetPassword,
};

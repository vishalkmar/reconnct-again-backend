const asyncHandler = require('express-async-handler');
const { Admin } = require('../models');
const { signToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');
const twoFa = require('../services/adminTwoFactor.service');

// kind:'admin' lets every auth middleware tell an admin token apart from the
// user / supplier / team tokens that share this signing secret — see
// middlewares/auth.middleware.js.
const issueAdminToken = (admin) => signToken({ id: admin.id, role: admin.role, kind: 'admin' });

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 'Email and password are required', 400);

  const admin = await Admin.findOne({ where: { email: email.toLowerCase().trim() } });
  if (!admin || !admin.isActive) return fail(res, 'Invalid credentials', 401);

  const matches = await admin.comparePassword(password);
  if (!matches) return fail(res, 'Invalid credentials', 401);

  // Password is correct. If the admin has turned on any second factor, DON'T
  // hand out a token yet — issue a short-lived challenge and require the factor
  // step. Admins with 2FA off log in exactly as before.
  if (twoFa.has2FA(admin)) {
    const factors = twoFa.enabledFactors(admin);
    // Email factor: send the code now so it's waiting when the UI asks for it.
    if (admin.twoFactorEmailEnabled) {
      await twoFa.sendEmailOtp(admin).catch((e) => console.error('[2fa] email otp send failed:', e.message));
    }
    return ok(res, {
      requires2fa: true,
      factors, // e.g. ['email','totp']
      challengeToken: twoFa.issueChallenge(admin),
      emailHint: admin.twoFactorEmailEnabled ? admin.email.replace(/^(.).*(@.*)$/, '$1***$2') : null,
    }, 'Additional verification required');
  }

  admin.lastLoginAt = new Date();
  await admin.save();
  return ok(res, { token: issueAdminToken(admin), admin: admin.toSafeJSON() }, 'Logged in');
});

// POST /api/auth/login/2fa  { challengeToken, emailCode?, totpCode? }
// Second step: verify every enabled factor, then issue the real admin token.
const verifyLogin2fa = asyncHandler(async (req, res) => {
  let decoded;
  try { decoded = twoFa.verifyChallenge(req.body.challengeToken); }
  catch { return fail(res, 'Your verification session expired — please sign in again.', 401); }

  const admin = await Admin.findByPk(decoded.id);
  if (!admin || !admin.isActive) return fail(res, 'Invalid credentials', 401);
  if (!twoFa.has2FA(admin)) return fail(res, 'No verification is required', 400);

  const result = await twoFa.verifyAllFactors(admin, {
    emailCode: req.body.emailCode,
    totpCode: req.body.totpCode,
  });
  if (!result.ok) return fail(res, result.reason || 'Verification failed', 401, { factor: result.factor });

  admin.lastLoginAt = new Date();
  await admin.save();
  return ok(res, { token: issueAdminToken(admin), admin: admin.toSafeJSON() }, 'Logged in');
});

// POST /api/auth/login/2fa/resend-email  { challengeToken }
const resendLoginEmailOtp = asyncHandler(async (req, res) => {
  let decoded;
  try { decoded = twoFa.verifyChallenge(req.body.challengeToken); }
  catch { return fail(res, 'Your verification session expired — please sign in again.', 401); }
  const admin = await Admin.findByPk(decoded.id);
  if (!admin || !admin.twoFactorEmailEnabled) return fail(res, 'Email verification is not enabled', 400);
  await twoFa.sendEmailOtp(admin);
  return ok(res, {}, 'A new code has been emailed to you');
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

module.exports = {
  login, verifyLogin2fa, resendLoginEmailOtp, me, changePassword,
};

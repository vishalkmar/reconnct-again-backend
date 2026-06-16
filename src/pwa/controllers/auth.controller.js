const asyncHandler = require('express-async-handler');
const { Auditor, Officer, PropertyOwner, Property } = require('../models');
const { signToken } = require('../../utils/jwt');
const { ok, fail } = require('../../utils/response');
const { issueOtp, verifyOtp, dispatchOtp, IS_DEV } = require('../services/otp');

const findUserByRole = async (role, email) => {
  if (role === 'auditor') return Auditor.findOne({ where: { email } });
  if (role === 'officer') return Officer.findOne({ where: { email } });
  return null;
};

const PASSWORD_LOGIN_ROLES = ['auditor', 'officer'];

const issuePwaToken = (role, id) =>
  signToken({ pwa: true, role, id });

// -- Identify login method from a single email --------------------------
//
// The PWA shows one unified login screen (just an email box). This endpoint
// tells the UI how to continue: auditors/officers authenticate with a
// password, everyone else (owners — including first-time self-onboarders)
// authenticates with an email OTP. Email is the unique key across all three
// roles. We never reveal whether an account exists for OTP emails (owners
// can self-onboard), so the response is intentionally non-sensitive.

const identify = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return fail(res, 'Email is required', 400);
  const normalized = email.toLowerCase().trim();

  const auditor = await Auditor.findOne({ where: { email: normalized } });
  if (auditor && auditor.isActive) {
    return ok(res, { email: normalized, method: 'password', role: 'auditor' });
  }

  const officer = await Officer.findOne({ where: { email: normalized } });
  if (officer && officer.isActive) {
    return ok(res, { email: normalized, method: 'password', role: 'officer' });
  }

  // Default: treat as a property owner — OTP flow, self-onboarding allowed.
  return ok(res, { email: normalized, method: 'otp', role: 'owner' });
});

// -- Auditor / Officer login --------------------------------------------

const login = asyncHandler(async (req, res) => {
  const { role, email, password } = req.body;
  if (!PASSWORD_LOGIN_ROLES.includes(role)) return fail(res, 'Invalid role', 400);
  if (!email || !password) return fail(res, 'Email and password are required', 400);

  const normalized = email.toLowerCase().trim();
  const user = await findUserByRole(role, normalized);
  if (!user || !user.isActive) return fail(res, 'Invalid credentials', 401);

  const matches = await user.comparePassword(password);
  if (!matches) return fail(res, 'Invalid credentials', 401);

  // Auto-issue an OTP if email is not yet verified — UI will redirect to
  // the OTP screen instead of completing login.
  if (!user.emailVerifiedAt) {
    const code = await issueOtp({
      email: normalized,
      target: role,
      purpose: 'signup_verify',
      ipAddress: req.ip,
    });
    const { delivered, devCode, error: emailError } = await dispatchOtp({
      email: normalized, code, purpose: 'signup_verify', role,
    });
    return ok(
      res,
      {
        requiresEmailVerification: true,
        role,
        email: normalized,
        emailDelivered: delivered,
        ...(IS_DEV && devCode ? { devCode, emailError } : {}),
      },
      delivered
        ? 'Verify your email to continue'
        : `Email failed (${emailError || 'unknown'}) — use the code shown in the server console`,
    );
  }

  user.lastLoginAt = new Date();
  await user.save();
  const token = issuePwaToken(role, user.id);
  return ok(res, { token, role, user: user.toSafeJSON() }, 'Logged in');
});

// Verify the OTP issued during signup_verify or login. On success, returns
// a real session token.
const verifyLoginOtp = asyncHandler(async (req, res) => {
  const { role, email, code } = req.body;
  if (!PASSWORD_LOGIN_ROLES.includes(role)) return fail(res, 'Invalid role', 400);
  if (!email || !code) return fail(res, 'Email and code are required', 400);

  const normalized = email.toLowerCase().trim();
  const result = await verifyOtp({
    email: normalized,
    target: role,
    purpose: 'signup_verify',
    code,
  });
  if (!result.ok) return fail(res, `OTP ${result.reason}`, 400);

  const user = await findUserByRole(role, normalized);
  if (!user || !user.isActive) return fail(res, 'Account not found or inactive', 401);

  user.emailVerifiedAt = new Date();
  user.lastLoginAt = new Date();
  await user.save();
  const token = issuePwaToken(role, user.id);
  return ok(res, { token, role, user: user.toSafeJSON() }, 'Email verified');
});

const resendOtp = asyncHandler(async (req, res) => {
  const { role, email, purpose = 'signup_verify' } = req.body;
  if (!PASSWORD_LOGIN_ROLES.includes(role)) return fail(res, 'Invalid role', 400);
  if (!email) return fail(res, 'Email is required', 400);
  const normalized = email.toLowerCase().trim();
  const user = await findUserByRole(role, normalized);
  if (!user) return fail(res, 'Account not found', 404);

  const code = await issueOtp({ email: normalized, target: role, purpose, ipAddress: req.ip });
  const { delivered, devCode, error: emailError } = await dispatchOtp({
    email: normalized, code, purpose, role,
  });
  return ok(
    res,
    {
      emailDelivered: delivered,
      ...(IS_DEV && devCode ? { devCode, emailError } : {}),
    },
    delivered ? 'OTP sent' : `Email failed (${emailError || 'unknown'}) — use the code from the server console`,
  );
});

// -- Owner login (passwordless via propertyCode + email + OTP) ----------

const ownerRequestOtp = asyncHandler(async (req, res) => {
  const { propertyCode, email } = req.body;
  if (!propertyCode || !email) return fail(res, 'Property ID and email are required', 400);

  const normalized = email.toLowerCase().trim();
  const property = await Property.findOne({ where: { propertyCode } });
  if (!property) return fail(res, 'Invalid Property ID', 404);
  if (property.ownerEmail.toLowerCase().trim() !== normalized) {
    return fail(res, 'This email is not on file for that Property ID', 403);
  }
  // Owner login is only unlocked AFTER the auditor releases the contract —
  // i.e. status moved past `approved`. While the contract sits with the
  // auditor (status === 'approved' / 'final_approved'), the owner can't
  // sign in via this code yet. The message tells them exactly what state
  // the property is in so the auditor can chase the right person.
  if (!['contract_sent', 'contract_signed', 'completed'].includes(property.status)) {
    const friendly = {
      draft: 'Audit has not started.',
      phase1_done: 'Audit basics captured — Phase 3 still in progress.',
      phase3_submitted: 'Audit submitted, waiting on reviewer.',
      in_review: 'Audit is under review with the reviewer.',
      in_revision: 'Audit is being revised by the auditor.',
      approved: 'Phase 3 approved — Phase 4 deep-dive still pending.',
      phase4_submitted: 'Phase 4 submitted, awaiting reviewer approval.',
      phase4_in_revision: 'Phase 4 needs revision before contract is generated.',
      final_approved: 'Property is final approved. Contract signing is in progress.',
      rejected: 'This property was rejected.',
    }[property.status] || 'Contract has not been sent yet.';
    return fail(res, `Owner access is not enabled yet — ${friendly}`, 403);
  }

  const code = await issueOtp({
    email: normalized,
    target: 'owner',
    purpose: 'owner_login',
    propertyCode,
    ipAddress: req.ip,
  });
  const { delivered, devCode, error: emailError } = await dispatchOtp({
    email: normalized, code, purpose: 'owner_login', role: 'owner',
  });
  return ok(
    res,
    {
      email: normalized,
      emailDelivered: delivered,
      ...(IS_DEV && devCode ? { devCode, emailError } : {}),
    },
    delivered ? 'OTP sent' : `Email failed (${emailError || 'unknown'}) — use the code from the server console`,
  );
});

const ownerVerifyOtp = asyncHandler(async (req, res) => {
  const { propertyCode, email, code } = req.body;
  if (!propertyCode || !email || !code) {
    return fail(res, 'Property ID, email and code are required', 400);
  }
  const normalized = email.toLowerCase().trim();
  const result = await verifyOtp({
    email: normalized,
    target: 'owner',
    purpose: 'owner_login',
    code,
    propertyCode,
  });
  if (!result.ok) return fail(res, `OTP ${result.reason}`, 400);

  // Upsert owner record
  let owner = await PropertyOwner.findOne({ where: { email: normalized } });
  if (!owner) {
    const property = await Property.findOne({ where: { propertyCode } });
    owner = await PropertyOwner.create({
      email: normalized,
      name: property?.ownerName || null,
      phone: property?.ownerPhone || null,
      emailVerifiedAt: new Date(),
      lastLoginAt: new Date(),
    });
    if (property && !property.ownerId) {
      property.ownerId = owner.id;
      await property.save();
    }
  } else {
    owner.emailVerifiedAt = owner.emailVerifiedAt || new Date();
    owner.lastLoginAt = new Date();
    await owner.save();
  }

  const token = issuePwaToken('owner', owner.id);
  return ok(res, { token, role: 'owner', user: owner.toSafeJSON(), propertyCode }, 'Logged in');
});

// -- /me ----------------------------------------------------------------

const me = asyncHandler(async (req, res) => {
  return ok(res, { role: req.pwaRole, user: req.pwaUser.toSafeJSON() });
});

const changePassword = asyncHandler(async (req, res) => {
  if (req.pwaRole === 'owner') return fail(res, 'Owners do not have a password', 400);
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return fail(res, 'Both passwords are required', 400);
  if (newPassword.length < 8) return fail(res, 'New password must be at least 8 characters', 400);

  const matches = await req.pwaUser.comparePassword(currentPassword);
  if (!matches) return fail(res, 'Current password is wrong', 400);

  req.pwaUser.password = newPassword;
  await req.pwaUser.save();
  return ok(res, {}, 'Password updated');
});

// -- Owner email-only login (for self-onboarding) -----------------------
//
// Lets a property owner sign in with just their email — no propertyCode
// required. On verify, if the owner has never logged in before we also
// capture their name + phone in the same call. After login the owner sees
// every property tied to their email (both auditor-onboarded and
// self-onboarded) and can self-onboard new ones from the dashboard.

const ownerEmailRequestOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return fail(res, 'Email is required', 400);
  const normalized = email.toLowerCase().trim();
  const owner = await PropertyOwner.findOne({ where: { email: normalized } });

  const code = await issueOtp({
    email: normalized,
    target: 'owner',
    purpose: 'owner_login',
    ipAddress: req.ip,
  });
  const { delivered, devCode, error: emailError } = await dispatchOtp({
    email: normalized, code, purpose: 'owner_login', role: 'owner',
  });
  return ok(
    res,
    {
      email: normalized,
      needsProfile: !owner,
      emailDelivered: delivered,
      ...(IS_DEV && devCode ? { devCode, emailError } : {}),
    },
    delivered ? 'OTP sent' : `Email failed (${emailError || 'unknown'}) — use the code from the server console`,
  );
});

const ownerEmailVerifyOtp = asyncHandler(async (req, res) => {
  const { email, code, name, phone } = req.body;
  if (!email || !code) return fail(res, 'Email and code are required', 400);
  const normalized = email.toLowerCase().trim();
  const result = await verifyOtp({
    email: normalized,
    target: 'owner',
    purpose: 'owner_login',
    code,
  });
  if (!result.ok) return fail(res, `OTP ${result.reason}`, 400);

  let owner = await PropertyOwner.findOne({ where: { email: normalized } });
  if (!owner) {
    if (!name?.trim()) {
      return fail(res, 'First-time owners must provide a name to continue', 400);
    }
    owner = await PropertyOwner.create({
      email: normalized,
      name: name.trim(),
      phone: phone?.trim() || null,
      emailVerifiedAt: new Date(),
      lastLoginAt: new Date(),
    });
  } else {
    if (!owner.name && name?.trim()) owner.name = name.trim();
    if (!owner.phone && phone?.trim()) owner.phone = phone.trim();
    owner.emailVerifiedAt = owner.emailVerifiedAt || new Date();
    owner.lastLoginAt = new Date();
    await owner.save();
  }

  // Back-link any auditor-created properties that recorded this email so
  // the owner sees them in their dashboard on first login.
  await Property.update(
    { ownerId: owner.id },
    { where: { ownerEmail: normalized, ownerId: null } },
  );

  const token = issuePwaToken('owner', owner.id);
  return ok(res, { token, role: 'owner', user: owner.toSafeJSON() }, 'Logged in');
});

module.exports = {
  identify,
  login,
  verifyLoginOtp,
  resendOtp,
  ownerRequestOtp,
  ownerVerifyOtp,
  ownerEmailRequestOtp,
  ownerEmailVerifyOtp,
  me,
  changePassword,
};

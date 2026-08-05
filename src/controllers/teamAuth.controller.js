const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { TeamMember } = require('../models');
const { availableRolesFor } = require('../models/teamMember.model');
const { signToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');
const {
  makeToken, hashToken, resetUrl, sendResetEmail,
} = require('../services/passwordReset.service');

// The member as the client should see it for a given ACTIVE role — a dual-role
// COPS working the QCOPS queue must look like a qcops to the whole frontend
// (which drives its layout/nav off member.roleType), while primaryRole/roles
// keep the real picture for the dashboard switcher.
const shape = (member, activeRole) => {
  const roles = availableRolesFor(member);
  const safe = member.toSafeJSON();
  return {
    member: { ...safe, roleType: activeRole || member.roleType },
    primaryRole: member.roleType,
    activeRole: activeRole || member.roleType,
    roles,
  };
};

// POST /api/team/auth/login  { email, password }
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 'Email and password are required', 400);

  const member = await TeamMember.findOne({ where: { email: String(email).toLowerCase().trim() } });
  if (!member || !member.isActive) return fail(res, 'Invalid credentials', 401);

  const matches = await member.comparePassword(password);
  if (!matches) return fail(res, 'Invalid credentials', 401);

  member.lastLoginAt = new Date();
  await member.save();

  const roles = availableRolesFor(member);
  // Token starts on the primary role. A dual-role member swaps it via
  // select-role once they pick a dashboard; the choice rides in the JWT so it
  // survives a reload without a spoofable header.
  const token = signToken({ id: member.id, kind: 'team_member', roleType: member.roleType, activeRole: member.roleType });
  return ok(res, { token, ...shape(member, member.roleType) }, 'Logged in');
});

// POST /api/team/auth/select-role  { role }  (authenticated)
// A member with more than one available dashboard picks which one to enter.
// Returns a fresh token stamped with that active role. Rejects any role the
// member isn't actually entitled to, so this can never be an escalation.
const selectRole = asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  const member = req.teamMember;
  const roles = availableRolesFor(member);
  if (!role || !roles.includes(role)) return fail(res, 'You do not have that dashboard', 403);

  const token = signToken({ id: member.id, kind: 'team_member', roleType: member.roleType, activeRole: role });
  return ok(res, { token, ...shape(member, role) }, 'Dashboard selected');
});

// GET /api/team/auth/me
const me = asyncHandler(async (req, res) => ok(res, shape(req.teamMember, req.activeRole)));

// POST /api/team/auth/forgot-password  { email }
// Always answers the same way so it never reveals whether an email is registered.
const forgotPassword = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!email) return fail(res, 'Email is required', 400);
  const member = await TeamMember.findOne({ where: { email } });
  if (member) {
    const { raw, hash, expires } = makeToken();
    member.passwordResetToken = hash;
    member.passwordResetExpires = expires;
    await member.save();
    sendResetEmail({
      to: email, name: member.name, url: resetUrl('team', email, raw), roleLabel: 'Team Portal account',
    }).catch((e) => console.error('[team forgot-password] mail failed:', e.message));
  }
  return ok(res, {}, 'If that email is registered, a password-reset link is on its way.');
});

// POST /api/team/auth/reset-password  { email, token, password }
const resetPassword = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!email || !token || !password) return fail(res, 'Email, token and new password are required', 400);
  if (password.length < 6) return fail(res, 'Password must be at least 6 characters', 400);
  const member = await TeamMember.findOne({
    where: { email, passwordResetToken: hashToken(token), passwordResetExpires: { [Op.gt]: new Date() } },
  });
  if (!member) return fail(res, 'This reset link is invalid or has expired. Please request a new one.', 400);
  member.password = password; // model hook re-hashes
  member.passwordResetToken = null;
  member.passwordResetExpires = null;
  await member.save();
  return ok(res, {}, 'Your password has been reset. You can now sign in.');
});

module.exports = {
  login, selectRole, me, forgotPassword, resetPassword,
};

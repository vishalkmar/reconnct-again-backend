const asyncHandler = require('express-async-handler');
const { TeamMember } = require('../models');
const { availableRolesFor } = require('../models/teamMember.model');
const { signToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');

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

module.exports = { login, selectRole, me };

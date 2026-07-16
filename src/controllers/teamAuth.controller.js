const asyncHandler = require('express-async-handler');
const { TeamMember } = require('../models');
const { signToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');

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

  const token = signToken({ id: member.id, kind: 'team_member', roleType: member.roleType });
  return ok(res, { token, member: member.toSafeJSON() }, 'Logged in');
});

// GET /api/team/auth/me
const me = asyncHandler(async (req, res) => ok(res, { member: req.teamMember.toSafeJSON() }));

module.exports = { login, me };

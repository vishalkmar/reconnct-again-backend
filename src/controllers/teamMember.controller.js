const asyncHandler = require('express-async-handler');
const { TeamMember } = require('../models');
const {
  ROLE_TYPES, ROLE_LABELS, PERMISSION_KEYS, defaultPermissionsFor,
} = require('../models/teamMember.model');
const { ok, created, fail } = require('../utils/response');
const { reassignOrphanedSuppliers } = require('../services/accountManager.service');

const PREFIX = {
  bd: 'BD',
  cops: 'COPS',
  account_manager: 'AM',
  csm: 'CSM',
  qcops: 'QCOPS',
  marketing_manager: 'MKT',
};

// e.g. "BD-0007" — counts existing members of that role and pads to 4
// digits; a retry loop handles the rare race where two creates land at the
// same count (unique index on employeeCode would reject the collision).
const nextEmployeeCode = async (roleType) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const count = await TeamMember.count({ where: { roleType } });
    const code = `${PREFIX[roleType]}-${String(count + 1 + attempt).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await TeamMember.findOne({ where: { employeeCode: code } });
    if (!clash) return code;
  }
  return `${PREFIX[roleType]}-${Date.now()}`;
};

// GET /api/admin/team/meta — role list + labels + permission keys + each
// role's default permission set, so the "Add Team Member" form can show the
// toggles a role will actually get the moment it's selected (not just on
// save) rather than lying to the admin about what will be created.
const meta = asyncHandler(async (req, res) => ok(res, {
  roles: ROLE_TYPES.map((r) => ({ value: r, label: ROLE_LABELS[r], defaultPermissions: defaultPermissionsFor(r) })),
  permissionKeys: PERMISSION_KEYS,
}));

// GET /api/admin/team
const list = asyncHandler(async (req, res) => {
  const members = await TeamMember.findAll({ order: [['createdAt', 'DESC']] });
  return ok(res, { members: members.map((m) => m.toSafeJSON()) });
});

// GET /api/admin/team/:id
const getOne = asyncHandler(async (req, res) => {
  const member = await TeamMember.findByPk(req.params.id);
  if (!member) return fail(res, 'Team member not found', 404);
  return ok(res, { member: member.toSafeJSON() });
});

// POST /api/admin/team  { name, email, password, roleType, permissions? }
// `permissions` (partial) overrides the role's defaults per-key — lets the
// admin uncheck/check anything even at creation time.
const create = asyncHandler(async (req, res) => {
  const { name, email, password, roleType, permissions } = req.body || {};
  if (!name || !email || !password || !roleType) {
    return fail(res, 'name, email, password and roleType are required', 400);
  }
  if (!ROLE_TYPES.includes(roleType)) return fail(res, 'Invalid roleType', 400);
  if (String(password).length < 6) return fail(res, 'Password must be at least 6 characters', 400);

  const emailNorm = String(email).toLowerCase().trim();
  const existing = await TeamMember.findOne({ where: { email: emailNorm } });
  if (existing) return fail(res, 'A team member with this email already exists', 400);

  const employeeCode = await nextEmployeeCode(roleType);
  const finalPermissions = { ...defaultPermissionsFor(roleType), ...(permissions || {}) };

  const member = await TeamMember.create({
    name: String(name).trim(),
    email: emailNorm,
    employeeCode,
    password: String(password),
    roleType,
    permissions: finalPermissions,
    createdByAdminId: req.admin.id,
  });

  return created(res, { member: member.toSafeJSON() }, 'Team member created');
});

// PUT /api/admin/team/:id  { name?, permissions?, isActive?, password? }
// roleType and employeeCode are immutable once created.
const update = asyncHandler(async (req, res) => {
  const member = await TeamMember.findByPk(req.params.id);
  if (!member) return fail(res, 'Team member not found', 404);

  const { name, permissions, isActive, password } = req.body || {};
  if (name !== undefined) member.name = String(name).trim();
  if (permissions !== undefined) member.permissions = { ...member.permissions, ...permissions };
  const wasActive = member.isActive;
  if (isActive !== undefined) member.isActive = !!isActive;
  if (password) {
    if (String(password).length < 6) return fail(res, 'Password must be at least 6 characters', 400);
    member.password = String(password);
  }
  await member.save();

  // Disabling an account manager would otherwise strand their suppliers on a
  // contact nobody can reach — hand those over to an active manager now, since
  // the assign-on-first-listing hook never fires again for them.
  if (wasActive && !member.isActive && member.roleType === 'account_manager') {
    reassignOrphanedSuppliers().catch(() => {});
  }

  return ok(res, { member: member.toSafeJSON() }, 'Team member updated');
});

// DELETE /api/admin/team/:id
const remove = asyncHandler(async (req, res) => {
  const member = await TeamMember.findByPk(req.params.id);
  if (!member) return fail(res, 'Team member not found', 404);
  await member.destroy();
  return ok(res, {}, 'Team member removed');
});

module.exports = {
  meta, list, getOne, create, update, remove,
};

const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');

// Internal staff accounts (Phase 1 of the role/RBAC system) — BD, Center
// Ops, Account Manager, Customer Success Manager, Quality Check Ops,
// Marketing Manager. Admin creates these and toggles which capabilities each
// one has; later phases (supplier/experience flows, review queues, round-
// robin assignment) all gate on `permissions`. Separate from the Admin model
// entirely so existing admin role checks (`authorize('superadmin', ...)`)
// are never affected by this.
const ROLE_TYPES = ['bd', 'cops', 'account_manager', 'csm', 'qcops', 'marketing_manager'];

const ROLE_LABELS = {
  bd: 'Business Developer',
  cops: 'Center Operations',
  account_manager: 'Account Manager',
  csm: 'Customer Success Manager',
  qcops: 'Quality Check Operations',
  marketing_manager: 'Marketing Manager',
};

// Every capability toggle the admin can flip for a team member, and which
// roles get it checked ON by default when first created (admin can still
// override any individual toggle regardless of role).
const PERMISSION_KEYS = [
  'canCreateSupplier',
  'canAddExperience',
  'canReviewListings',
  'canAssignQCOPS',
  'canManageAccounts',
  'canManageCustomers',
];

const ROLE_DEFAULT_PERMISSIONS = {
  bd: {
    canCreateSupplier: true, canAddExperience: true, canReviewListings: false, canAssignQCOPS: false, canManageAccounts: false, canManageCustomers: false,
  },
  cops: {
    canCreateSupplier: false, canAddExperience: false, canReviewListings: true, canAssignQCOPS: true, canManageAccounts: false, canManageCustomers: false,
  },
  account_manager: {
    canCreateSupplier: false, canAddExperience: false, canReviewListings: false, canAssignQCOPS: false, canManageAccounts: true, canManageCustomers: false,
  },
  // CSM is the customer-side counterpart to Account Manager — instead of
  // watching over suppliers, they watch over customers who've hit a "needs
  // help" signal (a failed payment or a cancelled booking), auto-assigned
  // the same least-loaded round-robin way — see csm.service.js.
  csm: {
    canCreateSupplier: false, canAddExperience: false, canReviewListings: false, canAssignQCOPS: false, canManageAccounts: false, canManageCustomers: true,
  },
  // QCOPS's whole job is reviewing what Center Ops escalates to them, so
  // canReviewListings defaults on — the review-queue endpoint itself scopes
  // a qcops-role member down to just their assigned items (see
  // reviewQueue.controller.js's list()), a cops-role member still sees
  // everything.
  qcops: {
    canCreateSupplier: false, canAddExperience: false, canReviewListings: true, canAssignQCOPS: false, canManageAccounts: false, canManageCustomers: false,
  },
  marketing_manager: {
    canCreateSupplier: false, canAddExperience: false, canReviewListings: false, canAssignQCOPS: false, canManageAccounts: false, canManageCustomers: false,
  },
};

const defaultPermissionsFor = (roleType) => ({ ...ROLE_DEFAULT_PERMISSIONS[roleType] });

const TeamMember = sequelize.define(
  'TeamMember',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(160), allowNull: false, validate: { isEmail: true } },
    // Immutable once set — admin can rename/re-email a member but this code
    // never changes, so it's a stable reference in QCOPS assignment lists,
    // round-robin logs, etc.
    employeeCode: { type: DataTypes.STRING(20), allowNull: false },
    password: { type: DataTypes.STRING(255), allowNull: false },
    roleType: { type: DataTypes.ENUM(...ROLE_TYPES), allowNull: false },
    // Flat capability flags — see PERMISSION_KEYS. Stored as JSON so adding a
    // new capability later doesn't need a migration.
    permissions: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    // Account Manager only — the most suppliers this KAM may hold. The
    // round-robin never assigns beyond it, and supplier creation is blocked
    // once every KAM is at their cap (admin raises it or adds a KAM). Ignored
    // for non-KAM roles.
    maxSuppliers: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 20 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    createdByAdminId: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: 'team_members',
    indexes: [
      { name: 'team_members_email_unique', unique: true, fields: ['email'] },
      { name: 'team_members_employee_code_unique', unique: true, fields: ['employeeCode'] },
    ],
    hooks: {
      beforeCreate: async (tm) => {
        if (tm.password) tm.password = await bcrypt.hash(tm.password, 10);
      },
      beforeUpdate: async (tm) => {
        if (tm.changed('password')) tm.password = await bcrypt.hash(tm.password, 10);
      },
    },
  }
);

TeamMember.prototype.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

TeamMember.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.password;
  return obj;
};

module.exports = TeamMember;
module.exports.ROLE_TYPES = ROLE_TYPES;
module.exports.ROLE_LABELS = ROLE_LABELS;
module.exports.PERMISSION_KEYS = PERMISSION_KEYS;
module.exports.defaultPermissionsFor = defaultPermissionsFor;

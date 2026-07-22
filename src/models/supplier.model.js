const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');

/*
  Supplier — the partner/vendor that runs experiences. An Experience optionally
  belongs to one Supplier (supplierId FK on the experience). Created & managed
  from the admin "Suppliers" tab (CRUD), or by a BD via the team portal.

  Phase 4: a supplier can also get their OWN login (password set here) and
  self-serve their own listings through a dashboard that's a straight clone of
  the Host system — see supplierAuth.middleware.js / supplier.routes.js.
  password stays null until someone (admin/BD, or later the supplier
  themself) sets one; a supplier with no password simply can't log in yet.
*/
const Supplier = sequelize.define(
  'Supplier',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    companyName: { type: DataTypes.STRING(240), allowNull: false },
    supplierName: { type: DataTypes.STRING(240), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    email: { type: DataTypes.STRING(200), allowNull: true },
    image: { type: DataTypes.STRING(500), allowNull: true },       // logo / photo (optional)
    b2bContract: { type: DataTypes.STRING(500), allowNull: true },  // uploaded contract URL (optional)
    notes: { type: DataTypes.TEXT, allowNull: true },
    // FCM token for the supplier's device — set when they sign in on the app,
    // so booking/reminder pushes reach them on the lock screen even with the
    // app closed (users already have this; suppliers didn't, so a booking on a
    // supplier-owned listing produced no outside notification at all).
    fcmToken: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    // Set when a BD (or other permitted staff) created this via the team
    // portal instead of the admin panel directly — null for admin-created
    // suppliers. Lets Center Ops / Account Manager tell sources apart later.
    createdByTeamMemberId: { type: DataTypes.INTEGER, allowNull: true },
    // Supplier's own login — bcrypt hashed like Admin/TeamMember. Null until
    // someone sets a password for this supplier.
    password: { type: DataTypes.STRING(255), allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    // Auto-assigned (least-loaded round robin across active account_manager
    // team members) the first time any experience gets linked to this
    // supplier — see accountManager.service.js. Null until that happens.
    accountManagerId: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: 'suppliers',
    indexes: [
      { fields: ['isActive'] },
      { fields: ['companyName'] },
    ],
    hooks: {
      beforeCreate: async (s) => {
        if (s.password) s.password = await bcrypt.hash(s.password, 10);
      },
      beforeUpdate: async (s) => {
        if (s.changed('password') && s.password) s.password = await bcrypt.hash(s.password, 10);
      },
    },
  }
);

Supplier.prototype.comparePassword = function (plain) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(plain, this.password);
};

Supplier.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.password;
  return obj;
};

module.exports = Supplier;

const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');

const Admin = sequelize.define(
  'Admin',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(160),
      allowNull: false,
      validate: { isEmail: true },
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('superadmin', 'admin', 'editor'),
      defaultValue: 'admin',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // ── Two-factor / MFA (admin panel Security tab) ──────────────────────
    // After the password is correct, any factor enabled here must ALSO pass
    // before an admin token is issued. All additive + nullable → no existing
    // admin login changes until the admin turns something on.
    twoFactorEmailEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Where email-2FA codes are DELIVERED. Separate from the login `email` so an
    // admin can receive codes at a real inbox they control. Falls back to the
    // login email when not set.
    twoFactorEmail: { type: DataTypes.STRING(180), allowNull: true },
    totpEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // The confirmed authenticator secret (base32). Never sent to the client
    // after setup (toSafeJSON strips it).
    totpSecret: { type: DataTypes.STRING(255), allowNull: true },
    // A secret generated during "set up authenticator" but not yet verified —
    // promoted to totpSecret only once the admin proves they can generate a code.
    totpPendingSecret: { type: DataTypes.STRING(255), allowNull: true },
    // Current email-2FA one-time code (bcrypt-hashed) + its expiry/attempts.
    twoFactorOtpHash: { type: DataTypes.STRING(255), allowNull: true },
    twoFactorOtpExpires: { type: DataTypes.DATE, allowNull: true },
    twoFactorOtpAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: 'admins',
    indexes: [
      { name: 'admins_email_unique', unique: true, fields: ['email'] },
    ],
    hooks: {
      beforeCreate: async (admin) => {
        if (admin.password) {
          admin.password = await bcrypt.hash(admin.password, 10);
        }
      },
      beforeUpdate: async (admin) => {
        if (admin.changed('password')) {
          admin.password = await bcrypt.hash(admin.password, 10);
        }
      },
    },
  }
);

Admin.prototype.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

Admin.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.password;
  // Never leak 2FA secrets or the pending email OTP.
  delete obj.totpSecret;
  delete obj.totpPendingSecret;
  delete obj.twoFactorOtpHash;
  delete obj.twoFactorOtpExpires;
  delete obj.twoFactorOtpAttempts;
  return obj;
};

module.exports = Admin;

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const User = sequelize.define(
  'User',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    email: {
      type: DataTypes.STRING(180),
      allowNull: false,
      validate: { isEmail: true },
    },
    name: { type: DataTypes.STRING(160), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },

    // Profile is "complete" once the user has finished the first-time
    // name + phone capture step. Returning users (existing in DB) skip that
    // step entirely.
    isProfileComplete: { type: DataTypes.BOOLEAN, defaultValue: false },

    // Optional profile fields the user can edit later from their dashboard.
    avatarUrl: { type: DataTypes.STRING(500), allowNull: true },
    gender: {
      type: DataTypes.ENUM('male', 'female', 'other', 'prefer_not_to_say'),
      allowNull: true,
    },
    dob: { type: DataTypes.DATEONLY, allowNull: true },
    addressLine: { type: DataTypes.STRING(255), allowNull: true },
    // Business / company name — used by the host ("Switch to Host") profile.
    company: { type: DataTypes.STRING(180), allowNull: true },
    city: { type: DataTypes.STRING(120), allowNull: true },
    state: { type: DataTypes.STRING(120), allowNull: true },
    country: { type: DataTypes.STRING(120), allowNull: true },
    pincode: { type: DataTypes.STRING(20), allowNull: true },

    // Refer & Earn — referral code is generated once on first profile completion.
    // referredByUserId is populated if this user signed up via somebody else's code.
    referralCode: { type: DataTypes.STRING(20), allowNull: true },
    referredByUserId: { type: DataTypes.INTEGER, allowNull: true },

    // Wallet balance accrues from refer-earn rewards. Stored as integer paise
    // to avoid float drift. (e.g. ₹100 = 10000)
    walletBalancePaise: { type: DataTypes.INTEGER, defaultValue: 0 },

    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },

    // Device push token for the mobile app (one per account — traveller and
    // host mode are the same User row, so a single token covers both).
    // Overwritten on every login/refresh; the latest write wins.
    fcmToken: { type: DataTypes.STRING(255), allowNull: true },

    // Auto-assigned (least-loaded round robin across active csm team
    // members) the first time this user hits a "needs help" signal — a
    // failed payment or a cancelled booking — see csm.service.js. Sticky
    // once set (same customer keeps the same CSM across future incidents).
    csmId: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: 'users',
    indexes: [
      { name: 'users_email_unique', unique: true, fields: ['email'] },
      { name: 'users_referral_code_unique', unique: true, fields: ['referralCode'] },
      { fields: ['referredByUserId'] },
    ],
  }
);

User.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  return obj;
};

module.exports = User;

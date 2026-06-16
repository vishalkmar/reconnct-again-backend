const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Coupon = sequelize.define(
  'Coupon',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    code: { type: DataTypes.STRING(40), allowNull: false },

    // null = public coupon (any user can redeem). non-null = personal coupon
    // (only that user can apply it — referral bonuses, manual gifts).
    userId: { type: DataTypes.INTEGER, allowNull: true },

    // Two flavours that cover almost every promo: percent off or flat off.
    // `value` carries the percent (0–100) or flat paise depending on kind.
    kind: { type: DataTypes.ENUM('percent', 'flat'), allowNull: false, defaultValue: 'percent' },
    value: { type: DataTypes.INTEGER, allowNull: false },

    // Optional caps and floors so a "20% off" can't accidentally hand out
    // a ₹50,000 discount on a luxury package.
    maxDiscountPaise: { type: DataTypes.INTEGER, allowNull: true },
    minOrderPaise: { type: DataTypes.INTEGER, defaultValue: 0 },

    // Total redemptions allowed across all users (and across all bookings if
    // public). Personal coupons usually have usageLimit=1.
    usageLimit: { type: DataTypes.INTEGER, defaultValue: 1 },
    timesUsed: { type: DataTypes.INTEGER, defaultValue: 0 },

    expiresAt: { type: DataTypes.DATE, allowNull: true },

    // Where did this coupon come from. Lets us filter the Refer & Earn page
    // to only the referral coupons even if the user has a mix of promos.
    reason: {
      type: DataTypes.ENUM('referral_signup', 'referral_referee', 'promo', 'admin'),
      defaultValue: 'promo',
    },

    description: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'coupons',
    indexes: [
      { name: 'coupons_code_unique', unique: true, fields: ['code'] },
      { fields: ['userId'] },
      { fields: ['isActive'] },
      { fields: ['reason'] },
    ],
  }
);

module.exports = Coupon;

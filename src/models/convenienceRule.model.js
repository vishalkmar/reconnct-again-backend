const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Convenience Fee Rule — the admin's GLOBAL convenience fee, set from
  Pricing Setup Management → Convenience Management.

  Same engine as MarkupRule / GstRule: four scopes, LATEST-APPLIED-WINS.
  The one difference is WHERE in the price it lands — markup goes on the B2B
  base and GST on the discounted amount, whereas the convenience fee is charged
  LAST, on the amount that already has GST in it:

      base → +markup → −discount → +GST → +CONVENIENCE FEE → payable

  Fee types match the shape `experience.convenienceFee` already stores:
     free       → nothing added (optionally "free for N months" plus a
                  cut-through amount shown struck-through as a saving)
     fixed      → a flat ₹ amount
     percentage → a % of the post-GST amount
*/
const ConvenienceRule = sequelize.define(
  'ConvenienceRule',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    scope: {
      type: DataTypes.ENUM('all', 'category', 'audience', 'experience'),
      allowNull: false,
      defaultValue: 'all',
    },
    targetIds: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    type: { type: DataTypes.ENUM('free', 'fixed', 'percentage'), allowNull: false, defaultValue: 'free' },
    value: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },

    // 'free' only: how many months it stays free, and the amount shown
    // struck-through in place of the fee so the saving is visible.
    months: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    cutThrough: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },

    note: { type: DataTypes.STRING(255), allowNull: true },

    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // The "latest wins" clock — bumped on create/edit, never on a pause/resume.
    appliedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },

    createdByAdminId: { type: DataTypes.INTEGER, allowNull: true },
    createdByName: { type: DataTypes.STRING(160), allowNull: true },
  },
  {
    tableName: 'convenience_rules',
    indexes: [
      { fields: ['scope'] },
      { fields: ['isActive'] },
      { fields: ['appliedAt'] },
    ],
  }
);

module.exports = ConvenienceRule;

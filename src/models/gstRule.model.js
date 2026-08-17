const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  GST Rule — the admin's GLOBAL GST, set from
  Pricing Setup Management → GST & Taxes Management.

  Same engine as MarkupRule (see markupRule.model.js): four scopes and a
  LATEST-APPLIED-WINS tie-break, so one mental model covers both modules.

    all        → every experience
    category   → the chosen broad categories        (targetIds = category ids)
    audience   → the chosen "Who is this for" tags  (targetIds = audience ids)
    experience → the chosen listings                (targetIds = experience ids)

  The rate resolved here is the rate WE charge on top of the marked-up B2B base.
  What actually gets charged also depends on the go-live GST decision stored on
  the experience (`experience.gstConfig`) — when the submitter already quoted a
  GST-inclusive price, Center Ops decides whether ours applies at all. See
  services/gstRule.service.js.
*/
const GstRule = sequelize.define(
  'GstRule',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    scope: {
      type: DataTypes.ENUM('all', 'category', 'audience', 'experience'),
      allowNull: false,
      defaultValue: 'all',
    },
    targetIds: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // GST percentage (0 / 5 / 12 / 18 / 28 in practice, any 0-100 accepted).
    rate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 18 },

    note: { type: DataTypes.STRING(255), allowNull: true },

    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // The "latest wins" clock — bumped on create/edit, never on a pause/resume.
    appliedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },

    createdByAdminId: { type: DataTypes.INTEGER, allowNull: true },
    createdByName: { type: DataTypes.STRING(160), allowNull: true },
  },
  {
    tableName: 'gst_rules',
    indexes: [
      { fields: ['scope'] },
      { fields: ['isActive'] },
      { fields: ['appliedAt'] },
    ],
  }
);

module.exports = GstRule;

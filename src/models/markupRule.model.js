const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Markup Rule — the admin's GLOBAL markup, set from
  Pricing Setup Management → Markup Management.

  Markup is no longer typed in per-experience at go-live. An admin adds rules
  here and every matching experience picks its markup up automatically (now and
  for any experience added later). Four scopes:

    all        → every experience
    category   → the chosen broad categories        (targetIds = category ids)
    audience   → the chosen "Who is this for" tags  (targetIds = audience ids)
    experience → the chosen live listings           (targetIds = experience ids)

  An experience can obviously be hit by more than one rule (its category has
  10%, its audience has 4%, and it has its own 5%). The tie-breaker is the one
  the user asked for: THE LATEST APPLIED RULE WINS — `appliedAt` is bumped every
  time a rule is created or edited, so the most recent decision is the effective
  one regardless of how broad or narrow it is.

  The go-live "Edit" button (a one-off override for a single experience) simply
  writes a scope:'experience' rule with a fresh appliedAt, so overrides live in
  the same table and obey the same rule.
*/
const MarkupRule = sequelize.define(
  'MarkupRule',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    scope: {
      type: DataTypes.ENUM('all', 'category', 'audience', 'experience'),
      allowNull: false,
      defaultValue: 'all',
    },
    // Ids the scope points at — empty for scope 'all'.
    targetIds: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    type: { type: DataTypes.ENUM('percentage', 'fixed'), allowNull: false, defaultValue: 'percentage' },
    value: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },

    // Optional admin note ("Diwali margin", "corporate uplift", …).
    note: { type: DataTypes.STRING(255), allowNull: true },

    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // The "latest wins" clock. Bumped on every create/edit — NOT on a toggle,
    // so pausing and resuming a rule doesn't silently promote it over newer ones.
    appliedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },

    // Who set it (admin id) — purely for the audit column in the rules table.
    createdByAdminId: { type: DataTypes.INTEGER, allowNull: true },
    createdByName: { type: DataTypes.STRING(160), allowNull: true },
  },
  {
    tableName: 'markup_rules',
    indexes: [
      { fields: ['scope'] },
      { fields: ['isActive'] },
      { fields: ['appliedAt'] },
    ],
  }
);

module.exports = MarkupRule;

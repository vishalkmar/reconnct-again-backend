const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Per-tab configuration for the "Featured Retreats" home section. There are
// exactly four tabs (all / hotels / packages / events) and each can have an
// admin-managed banner image plus a custom headline & subhead. Rows are
// pre-seeded on first boot so the admin UI always has 4 entries to edit.
const FeaturedTab = sequelize.define(
  'FeaturedTab',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    tabKey: {
      type: DataTypes.STRING(20),
      allowNull: false,
      comment: "One of 'all', 'hotels', 'packages', 'events'",
    },

    label: { type: DataTypes.STRING(80), allowNull: true },
    sublabel: { type: DataTypes.STRING(120), allowNull: true },

    headline: { type: DataTypes.STRING(220), allowNull: true },
    subheadline: { type: DataTypes.TEXT, allowNull: true },

    imageUrl: { type: DataTypes.STRING(500), allowNull: true },

    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'featured_tabs',
    indexes: [
      { name: 'featured_tabs_tabKey_unique', unique: true, fields: ['tabKey'] },
    ],
  }
);

module.exports = FeaturedTab;

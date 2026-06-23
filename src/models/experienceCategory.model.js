const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Experience Category — the "Experience Categories" broad buckets from the
  Reconnct chart (Wellness & Well-being, Adventure & Outdoors, …). An experience
  picks exactly ONE broad category (single-select). Each category owns many
  ExperienceTypes. Admins can add custom categories on the fly.
*/
const ExperienceCategory = sequelize.define(
  'ExperienceCategory',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    icon: { type: DataTypes.STRING(40), allowNull: true, comment: 'Optional emoji / icon key' },
    colorHex: { type: DataTypes.STRING(9), allowNull: true, comment: 'Optional accent colour' },
    // Which audiences this category belongs to (audience slugs). Empty = shows
    // for every audience (so legacy categories keep working). Drives the admin
    // form's "select audience → filter categories" behaviour.
    audiences: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    isCustom: { type: DataTypes.BOOLEAN, defaultValue: false },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'experience_categories',
    indexes: [
      { name: 'experience_categories_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = ExperienceCategory;

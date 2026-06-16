const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Experience Type — the small sub-items listed under each broad category in the
  Reconnct chart (e.g. under "Wellness & Well-being": Retreats, Yoga &
  Meditation, Ayurveda, …). A type belongs to exactly one ExperienceCategory.
  When an admin picks a broad category in the form, the type dropdown is filled
  from this table (filtered by categoryId). Admins can add custom types inline.
*/
const ExperienceType = sequelize.define(
  'ExperienceType',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    categoryId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    isCustom: { type: DataTypes.BOOLEAN, defaultValue: false },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'experience_types',
    indexes: [
      // Slug unique *within* a category so two categories can both have a
      // "Retreats" type without clashing.
      { name: 'experience_types_cat_slug_unique', unique: true, fields: ['categoryId', 'slug'] },
      { fields: ['categoryId'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = ExperienceType;

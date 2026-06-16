const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Unified, polymorphic review table. Replaces the legacy package_reviews table —
// existing rows are migrated over on first server boot by
// `scripts/migrateReviews.js`. The entityType + entityId pair points at one of
// Package / Event / Hotel; controllers route by entityType so no real FK is set.
const Review = sequelize.define(
  'Review',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    entityType: {
      type: DataTypes.ENUM('package', 'event', 'hotel'),
      allowNull: false,
    },
    entityId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(160), allowNull: true },
    rating: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
    title: { type: DataTypes.STRING(160), allowNull: true },
    comment: { type: DataTypes.TEXT, allowNull: true },
    avatarUrl: { type: DataTypes.STRING(500), allowNull: true },
    isApproved: { type: DataTypes.BOOLEAN, defaultValue: false },
  },
  {
    tableName: 'reviews',
    indexes: [
      { fields: ['entityType', 'entityId'] },
      { fields: ['isApproved'] },
    ],
  }
);

module.exports = Review;

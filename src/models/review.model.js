const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Unified, polymorphic review table. Replaces the legacy package_reviews table —
// existing rows are migrated over on first server boot by
// `scripts/migrateReviews.js`. The entityType + entityId pair points at one of
// Package / Event / Hotel / Experience; controllers route by entityType so no
// real FK is set on entityId itself.
//
// `experience` reviews are a different flow from the other three: they're
// submitted by a real signed-in user for a specific completed Booking (not an
// anonymous name/email form), so userId/bookingId are populated for those and
// left null for the legacy anonymous package/event/hotel reviews. They're also
// auto-published (isApproved:true on create) — no moderation queue, matching
// the "one review per completed booking" flow.
const Review = sequelize.define(
  'Review',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    entityType: {
      type: DataTypes.ENUM('package', 'event', 'hotel', 'experience'),
      allowNull: false,
    },
    entityId: { type: DataTypes.INTEGER, allowNull: false },
    // Experience reviews only — ties the review to the real user + the exact
    // completed booking it's for (one review per booking).
    userId: { type: DataTypes.INTEGER, allowNull: true },
    bookingId: { type: DataTypes.INTEGER, allowNull: true },
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
      { fields: ['bookingId'] },
      { fields: ['userId'] },
    ],
  }
);

module.exports = Review;

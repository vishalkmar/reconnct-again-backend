const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// One row per (property, sectionKey). Officer flips between approved /
// rejected (with comment). On a rejection, the corresponding PropertyField
// stays editable for the auditor; on auditor re-submit, decision resets to
// 'pending'.

const FieldReview = sequelize.define(
  'FieldReview',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    propertyId: { type: DataTypes.INTEGER, allowNull: false },
    sectionKey: { type: DataTypes.STRING(40), allowNull: false },
    decision: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      defaultValue: 'pending',
    },
    comment: { type: DataTypes.TEXT, allowNull: true },
    approvedForFutureReview: { type: DataTypes.BOOLEAN, defaultValue: false },
    officerId: { type: DataTypes.INTEGER, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_field_reviews',
    indexes: [
      {
        name: 'pwa_review_property_section_unique',
        unique: true,
        fields: ['propertyId', 'sectionKey'],
      },
    ],
  }
);

module.exports = FieldReview;

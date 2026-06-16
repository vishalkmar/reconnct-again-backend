const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

/*
  Phase 4 deep-dive data. One row per (property, sectionKey) — same shape
  as PropertyField but for CRM-style structured data instead of free-text +
  photos. The `data` blob is whitelisted against PHASE4_SCHEMA at write
  time so users can't slip arbitrary keys in.

  Status drives the officer-side review: pending → approved | rejected.
  When the officer rejects a section, `feedback` carries the reason and
  the auditor sees it in their objections list (re-using the existing
  phase-3 objection pattern).
*/
const PropertyPhase4Data = sequelize.define(
  'PropertyPhase4Data',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    propertyId: { type: DataTypes.INTEGER, allowNull: false },
    sectionKey: { type: DataTypes.STRING(40), allowNull: false },
    data: { type: DataTypes.JSON, defaultValue: {} },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      defaultValue: 'pending',
    },
    feedback: { type: DataTypes.TEXT, allowNull: true },
    iteration: { type: DataTypes.INTEGER, defaultValue: 1 },
    updatedByAuditorAt: { type: DataTypes.DATE, allowNull: true },
    reviewedByOfficerAt: { type: DataTypes.DATE, allowNull: true },
    reviewedByOfficerId: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: 'pwa_property_phase4_data',
    indexes: [
      {
        name: 'pwa_phase4_property_section_unique',
        unique: true,
        fields: ['propertyId', 'sectionKey'],
      },
      { fields: ['status'] },
    ],
  }
);

module.exports = PropertyPhase4Data;

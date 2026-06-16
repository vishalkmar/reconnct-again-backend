const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// One row per (property, sectionKey) — the 8-ish Phase-3 sections.
// `iteration` increments whenever the auditor re-uploads after the officer
// rejected the field, so we can show "rev 2" hints in the UI.

const PropertyField = sequelize.define(
  'PropertyField',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    propertyId: { type: DataTypes.INTEGER, allowNull: false },
    sectionKey: { type: DataTypes.STRING(40), allowNull: false },
    description: { type: DataTypes.TEXT('long'), allowNull: true },
    photoUrls: { type: DataTypes.JSON, defaultValue: [] },
    iteration: { type: DataTypes.INTEGER, defaultValue: 1 },
    // Snapshots of previous (description + photoUrls) per iteration so the
    // officer can compare what the auditor uploaded the first time vs. on
    // each re-upload after an objection.
    // Entry shape: { iteration, photoUrls, description, snapshotAt, reviewComment }
    photoHistory: { type: DataTypes.JSON, defaultValue: [] },
    // Structured "deep-dive" fields per section — formerly Phase 4. Stored
    // as a free-form JSON blob keyed by PHASE4_SCHEMA[sectionKey]. The
    // Rooms section also keeps its per-room records here under
    // `deepDiveData.rooms`, room-type categories under `deepDiveData.categories`,
    // and the window-room count under `deepDiveData.windowRooms`.
    deepDiveData: { type: DataTypes.JSON, defaultValue: {} },
    updatedByAuditorAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_property_fields',
    indexes: [
      {
        name: 'pwa_field_property_section_unique',
        unique: true,
        fields: ['propertyId', 'sectionKey'],
      },
    ],
  }
);

module.exports = PropertyField;

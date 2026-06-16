const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

/*
  One row per uploaded final-listing image.  Auditors revisit the property
  after approval and capture / upload section-tagged images that will be
  shown on the public website (separate from the in-audit photos stored on
  PropertyField).

  Section keys reuse the same SECTION_KEYS list as the audit so the auditor
  doesn't have to learn a second taxonomy.
*/
const ListingImage = sequelize.define(
  'ListingImage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    propertyId: { type: DataTypes.INTEGER, allowNull: false },
    auditorId:  { type: DataTypes.INTEGER, allowNull: false },

    sectionKey: { type: DataTypes.STRING(40), allowNull: false },

    url:        { type: DataTypes.STRING(500), allowNull: false },
    caption:    { type: DataTypes.STRING(255), allowNull: true },

    // 'live'   — captured via the device camera (PhotoUploader live mode)
    // 'upload' — picked from the gallery
    captureMode: {
      type: DataTypes.ENUM('live', 'upload'),
      defaultValue: 'upload',
    },

    sortOrder:  { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'pwa_listing_images',
    indexes: [
      { fields: ['propertyId'] },
      { fields: ['propertyId', 'sectionKey'] },
      { fields: ['auditorId'] },
    ],
  }
);

module.exports = ListingImage;

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Event = sequelize.define(
  'Event',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Identity
    name: { type: DataTypes.STRING(220), allowNull: false },
    slug: { type: DataTypes.STRING(240), allowNull: false },

    // Type & location (FKs to taxonomies)
    eventTypeId: { type: DataTypes.INTEGER, allowNull: true },
    locationId: { type: DataTypes.INTEGER, allowNull: true },
    cityName: { type: DataTypes.STRING(160), allowNull: true },
    address: { type: DataTypes.STRING(500), allowNull: true },

    // Schedule
    eventDate: { type: DataTypes.DATEONLY, allowNull: true, comment: 'Specific date if one-off' },
    startTime: { type: DataTypes.STRING(8), allowNull: true, comment: 'HH:mm display string' },
    endTime: { type: DataTypes.STRING(8), allowNull: true },
    // For multi-day events
    endDate: { type: DataTypes.DATEONLY, allowNull: true },

    // Pricing
    price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    priceOriginal: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },
    // GST percent added to the price at checkout (0 = Off). One of 0/5/18/28/40.
    gstRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // How the price is charged + the public unit label. See config/priceType.js.
    priceType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'per_person' },
    priceLabel: { type: DataTypes.STRING(60), allowNull: true },

    // Age limits
    minAge: { type: DataTypes.INTEGER, allowNull: true },
    maxAge: { type: DataTypes.INTEGER, allowNull: true },

    // Media
    mainImage: { type: DataTypes.STRING(500), allowNull: true },
    mapEmbedHtml: { type: DataTypes.TEXT('long'), allowNull: true },

    // Rich-text content
    aboutRich: { type: DataTypes.TEXT('long'), allowNull: true },
    highlightsRich: { type: DataTypes.TEXT('long'), allowNull: true },
    termsConditions: { type: DataTypes.TEXT('long'), allowNull: true },
    privacyPolicy: { type: DataTypes.TEXT('long'), allowNull: true },

    // For sport-type events: list of sub-sports user can pick. JSON array of
    // { id, name, defaultPrice } — slots are bound to specific sport names.
    sports: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Sub-sport options for sport-type events',
    },

    // Cancellation / refund
    isRefundable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    refundPolicyOverride: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Per-item refund tiers — same shape as RefundPolicy.tiers. When null the global policy is used.',
    },

    // Admin-added "additional fields" from the PWA→website listing config,
    // rendered as their own titled blocks. Shape: [{ name, type, value }].
    extraSections: { type: DataTypes.JSON, defaultValue: [] },

    // Flags
    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },

    // Ratings — populated from approved reviews via Review controller's recompute
    rating: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0 },
    reviewCount: { type: DataTypes.INTEGER, defaultValue: 0 },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'events',
    indexes: [
      { name: 'events_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['eventTypeId'] },
      { fields: ['locationId'] },
      { fields: ['eventDate'] },
      { fields: ['isActive'] },
      { fields: ['isFeatured'] },
    ],
  }
);

module.exports = Event;

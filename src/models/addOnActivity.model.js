const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const AddOnActivity = sequelize.define(
  'AddOnActivity',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Identity
    name: { type: DataTypes.STRING(220), allowNull: false },
    slug: { type: DataTypes.STRING(240), allowNull: false },

    // An activity is attached to a hotel, a package, or is general (shown
    // everywhere as a suggestion). `ownerType` records which; the matching
    // FK is set and the other stays null.
    ownerType: {
      type: DataTypes.ENUM('general', 'hotel', 'package'),
      allowNull: false,
      defaultValue: 'general',
    },
    hotelId: { type: DataTypes.INTEGER, allowNull: true },
    packageId: { type: DataTypes.INTEGER, allowNull: true },

    // Location (FK to Location taxonomy = Indian state) + manual city/address.
    // city/address power the "outside" suggestion matching on the public site.
    locationId: { type: DataTypes.INTEGER, allowNull: true },
    cityName: { type: DataTypes.STRING(160), allowNull: true },
    address: { type: DataTypes.STRING(500), allowNull: true },

    // Pricing
    price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    priceOriginal: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },
    // GST percent added to the price at checkout (0 = Off). One of 0/5/18/28/40.
    gstRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // TCS percent applied on price + GST (0 = Off).
    tcsRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // How the price is charged + the public unit label. See config/priceType.js.
    priceType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'per_person' },
    priceLabel: { type: DataTypes.STRING(60), allowNull: true },

    // Media
    mainImage: { type: DataTypes.STRING(500), allowNull: true },

    // Rich-text content
    descriptionRich: { type: DataTypes.TEXT('long'), allowNull: true },
    highlightsRich: { type: DataTypes.TEXT('long'), allowNull: true },

    // Age limits
    minAge: { type: DataTypes.INTEGER, allowNull: true },
    maxAge: { type: DataTypes.INTEGER, allowNull: true },

    // FAQs — JSON array of { question, answer }
    faqs: { type: DataTypes.JSON, defaultValue: [] },

    // Cancellation / refund
    isRefundable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    refundPolicyOverride: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Per-item refund tiers — same shape as RefundPolicy.tiers. When null the global policy is used.',
    },

    // Flags
    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'add_on_activities',
    indexes: [
      { name: 'add_on_activities_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['locationId'] },
      { fields: ['hotelId'] },
      { fields: ['packageId'] },
      { fields: ['isActive'] },
      { fields: ['isFeatured'] },
    ],
  }
);

module.exports = AddOnActivity;

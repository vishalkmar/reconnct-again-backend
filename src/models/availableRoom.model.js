const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const AvailableRoom = sequelize.define(
  'AvailableRoom',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // A room is owned by EITHER a hotel OR a package (mutually exclusive).
    // `ownerType` records which; the other FK stays null.
    ownerType: {
      type: DataTypes.ENUM('hotel', 'package'),
      allowNull: false,
      defaultValue: 'hotel',
    },
    hotelId: { type: DataTypes.INTEGER, allowNull: true },
    packageId: { type: DataTypes.INTEGER, allowNull: true },

    // Identity
    name: { type: DataTypes.STRING(220), allowNull: false },
    slug: {
      type: DataTypes.STRING(240),
      allowNull: false,
      comment: 'Unique within a hotel — combined with hotelId',
    },

    // Pricing
    price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    priceOriginal: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },
    // GST percent added to the price at checkout (0 = Off). One of 0/5/18/28/40.
    gstRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // TCS percent applied on price + GST (0 = Off).
    tcsRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // How the price is charged + the public unit label. See config/priceType.js.
    priceType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'per_night' },
    priceLabel: { type: DataTypes.STRING(60), allowNull: true },

    // Specs
    roomSize: {
      type: DataTypes.STRING(60),
      allowNull: true,
      comment: 'Display string like "350 sqft" or "32 m²"',
    },
    maxOccupancy: { type: DataTypes.INTEGER, defaultValue: 2 },
    // Children up to this count stay free (legacy; superseded by
    // extraPersonTiers). Kept for backward compatibility.
    maxChildrenFree: { type: DataTypes.INTEGER, defaultValue: 0 },

    // Free-text facility list (used by PWA-published rooms whose facilities are
    // plain strings, not the Facility taxonomy). Rendered as chips on the
    // public room card/detail. Array of strings.
    facilitiesList: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // Extra-person pricing tiers by age band. Each entry:
    //   { ageFrom, ageTo, priceType: 'free'|'custom', price, bed: 'with'|'without' }
    // `price` is per person, per night. Drives real-time booking maths and the
    // "extra guest" filters on the public site.
    extraPersonTiers: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // Media
    mainImage: { type: DataTypes.STRING(500), allowNull: true },

    // Rich-text content
    shortDescription: { type: DataTypes.TEXT('long'), allowNull: true },
    highlightsRich: { type: DataTypes.TEXT('long'), allowNull: true },
    descriptionRich: { type: DataTypes.TEXT('long'), allowNull: true },
    inclusionsRich: { type: DataTypes.TEXT('long'), allowNull: true },
    exclusionsRich: { type: DataTypes.TEXT('long'), allowNull: true },

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
    tableName: 'available_rooms',
    indexes: [
      { name: 'available_rooms_hotel_slug_unique', unique: true, fields: ['hotelId', 'slug'] },
      { fields: ['hotelId'] },
      { fields: ['packageId'] },
      { fields: ['isActive'] },
      { fields: ['price'] },
    ],
  }
);

module.exports = AvailableRoom;

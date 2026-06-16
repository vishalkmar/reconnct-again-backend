const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Hotel = sequelize.define(
  'Hotel',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Basic
    name: { type: DataTypes.STRING(220), allowNull: false },
    slug: { type: DataTypes.STRING(240), allowNull: false },
    shortDescription: { type: DataTypes.TEXT('long'), allowNull: true },
    description: { type: DataTypes.TEXT('long'), allowNull: true },

    // Media
    primaryImage: { type: DataTypes.STRING(500), allowNull: true },
    videoUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'Overview video URL (YouTube/Vimeo/MP4)',
    },
    videoType: {
      type: DataTypes.STRING(40),
      allowNull: true,
      comment: 'Provider hint: youtube | vimeo | mp4 | other',
    },

    // Location — Hotel belongs to a Location (now an Indian state) and a city.
    locationId: { type: DataTypes.INTEGER, allowNull: true },
    cityId: { type: DataTypes.INTEGER, allowNull: true },
    // Free-text city, typed manually next to the state. Preferred over cityId.
    cityName: { type: DataTypes.STRING(160), allowNull: true },
    address: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'Full street address',
    },
    mapEmbedHtml: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'Google Maps embed iframe HTML',
    },

    // Ratings — independent fields:
    //   rating      = user/displayed rating (0–5, decimal)
    //   starRating  = hotel star category (1–5, integer) for filtering
    rating: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0 },
    reviewCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    starRating: { type: DataTypes.INTEGER, allowNull: true, comment: '1–5 hotel-star classification' },

    // Pricing — min "from" price; usually derived from cheapest AvailableRoom
    // but admin can override.
    priceFrom: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    priceOriginal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Strike-through price for discount display',
    },
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },

    // Rich-text content blocks (HTML)
    highlightsRich: { type: DataTypes.TEXT('long'), allowNull: true },
    inclusionsRich: { type: DataTypes.TEXT('long'), allowNull: true },
    exclusionsRich: { type: DataTypes.TEXT('long'), allowNull: true },
    termsConditions: { type: DataTypes.TEXT('long'), allowNull: true },
    privacyPolicy: { type: DataTypes.TEXT('long'), allowNull: true },

    // FAQs — JSON array of { question, answer }
    faqs: { type: DataTypes.JSON, defaultValue: [] },

    // Admin-added "additional fields" from the PWA→website listing config.
    // Rendered as their own titled blocks on the public detail page (NOT merged
    // into the About description). Shape: [{ name, type:'text'|'image', value }]
    // where text `value` is rich-text HTML and image `value` is a URL.
    extraSections: { type: DataTypes.JSON, defaultValue: [] },

    // Flags
    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },

    // SEO
    metaTitle: { type: DataTypes.STRING(255), allowNull: true },
    metaDescription: { type: DataTypes.STRING(500), allowNull: true },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'hotels',
    indexes: [
      { name: 'hotels_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['locationId'] },
      { fields: ['cityId'] },
      { fields: ['isActive'] },
      { fields: ['isFeatured'] },
      { fields: ['priceFrom'] },
      { fields: ['starRating'] },
    ],
  }
);

module.exports = Hotel;

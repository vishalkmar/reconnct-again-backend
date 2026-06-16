const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PROMO_TYPES = [
  'image-single',
  'image-carousel',
  'image-text',
  'video-single',
  'video-carousel',
];

const PROMO_PAGES = [
  'home',
  'hotels',
  'retreats',
  'events',
  'all',
];

const PROMO_POSITIONS = [
  'below-video-testimonials',
  'below-hero',
  'below-featured',
  'above-footer',
];

const PromoBanner = sequelize.define(
  'PromoBanner',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    name: { type: DataTypes.STRING(160), allowNull: false, comment: 'Admin-only label' },

    type: {
      type: DataTypes.ENUM(...PROMO_TYPES),
      allowNull: false,
      defaultValue: 'image-single',
    },

    page: {
      type: DataTypes.ENUM(...PROMO_PAGES),
      allowNull: false,
      defaultValue: 'home',
      comment: 'Which public page to render on (or all)',
    },

    position: {
      type: DataTypes.ENUM(...PROMO_POSITIONS),
      allowNull: false,
      defaultValue: 'below-video-testimonials',
    },

    // For image-text type or any banner that wants overlay copy
    heading: { type: DataTypes.STRING(220), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    ctaLabel: { type: DataTypes.STRING(120), allowNull: true },
    ctaUrl: { type: DataTypes.STRING(500), allowNull: true },

    // Dimensions
    heightPx: { type: DataTypes.INTEGER, defaultValue: 360 },
    widthMode: {
      type: DataTypes.ENUM('full', 'container'),
      defaultValue: 'container',
      comment: 'full = edge-to-edge viewport, container = constrained max-width',
    },

    // Carousel behaviour
    autoplay: { type: DataTypes.BOOLEAN, defaultValue: true },
    intervalMs: { type: DataTypes.INTEGER, defaultValue: 5000 },

    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'promo_banners',
    indexes: [
      { fields: ['page', 'position', 'isActive'] },
      { fields: ['sortOrder'] },
    ],
  }
);

PromoBanner.PROMO_TYPES = PROMO_TYPES;
PromoBanner.PROMO_PAGES = PROMO_PAGES;
PromoBanner.PROMO_POSITIONS = PROMO_POSITIONS;

module.exports = PromoBanner;

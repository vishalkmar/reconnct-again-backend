const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Hero types per spec:
   - image           : single image only
   - image_text      : single image + text overlay
   - image_carousel  : multiple images
   - image_carousel_text : multiple images + text overlay (per slide or shared)
   - video           : single video
   - video_carousel  : multiple videos
*/
const HERO_TYPES = [
  'image',
  'image_text',
  'image_carousel',
  'image_carousel_text',
  'video',
  'video_carousel',
];

const Hero = sequelize.define(
  'Hero',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false }, // admin label
    type: { type: DataTypes.ENUM(...HERO_TYPES), allowNull: false },
    pageKey: {
      type: DataTypes.STRING(60),
      allowNull: false,
      defaultValue: 'home',
      comment: 'Which page this hero belongs to (home, retreats, about, etc.)',
    },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    heading: { type: DataTypes.STRING(255), allowNull: true },
    subheading: { type: DataTypes.STRING(500), allowNull: true },
    ctaLabel: { type: DataTypes.STRING(100), allowNull: true },
    ctaUrl: { type: DataTypes.STRING(500), allowNull: true },
    textPosition: {
      type: DataTypes.ENUM('left', 'center', 'right'),
      defaultValue: 'center',
    },
    textColor: { type: DataTypes.STRING(20), defaultValue: '#ffffff' },
    overlayOpacity: { type: DataTypes.INTEGER, defaultValue: 35 }, // 0-100
    autoplay: { type: DataTypes.BOOLEAN, defaultValue: true },
    intervalMs: { type: DataTypes.INTEGER, defaultValue: 5000 },
    height: {
      type: DataTypes.ENUM('sm', 'md', 'lg', 'full'),
      defaultValue: 'lg',
    },
    widthMode: {
      type: DataTypes.ENUM('full', 'large', 'medium', 'small', 'custom'),
      defaultValue: 'large',
      comment: 'full=100vw, large=container, medium=75% of container, small=50%, custom=widthValue%',
    },
    widthValue: {
      type: DataTypes.INTEGER,
      defaultValue: 100,
      comment: 'Used when widthMode=custom (percentage 10-100)',
    },
    heightValue: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Used when height preset is overridden — height in vh (10-100)',
    },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'heroes',
    indexes: [
      { fields: ['pageKey'] },
      { fields: ['isActive'] },
    ],
  }
);

Hero.HERO_TYPES = HERO_TYPES;
module.exports = Hero;

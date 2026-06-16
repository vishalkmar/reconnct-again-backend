const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PromoBannerSlide = sequelize.define(
  'PromoBannerSlide',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bannerId: { type: DataTypes.INTEGER, allowNull: false },

    mediaType: {
      type: DataTypes.ENUM('image', 'video'),
      allowNull: false,
      defaultValue: 'image',
    },
    mediaUrl: {
      type: DataTypes.STRING(700),
      allowNull: false,
      comment: 'Uploaded file URL or external link (YouTube/Vimeo/MP4)',
    },
    videoProvider: {
      type: DataTypes.STRING(40),
      allowNull: true,
      comment: 'youtube | vimeo | mp4 | other — only for video slides',
    },

    // Optional overlay copy per slide (used when banner type is image-text)
    caption: { type: DataTypes.STRING(255), allowNull: true },
    overlayHeading: { type: DataTypes.STRING(255), allowNull: true },
    overlayText: { type: DataTypes.TEXT, allowNull: true },
    linkUrl: { type: DataTypes.STRING(500), allowNull: true },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'promo_banner_slides',
    indexes: [{ fields: ['bannerId'] }],
  }
);

module.exports = PromoBannerSlide;

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const HeroMedia = sequelize.define(
  'HeroMedia',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    heroId: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(500), allowNull: false },
    mediaType: {
      type: DataTypes.ENUM('image', 'video'),
      allowNull: false,
      defaultValue: 'image',
    },
    alt: { type: DataTypes.STRING(255), allowNull: true },
    caption: { type: DataTypes.STRING(500), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'hero_media',
    indexes: [{ fields: ['heroId'] }],
  }
);

module.exports = HeroMedia;

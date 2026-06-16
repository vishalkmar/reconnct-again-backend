const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const TestimonialMedia = sequelize.define(
  'TestimonialMedia',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    testimonialId: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(500), allowNull: false },
    mediaType: {
      type: DataTypes.ENUM('image', 'video'),
      defaultValue: 'image',
    },
    caption: { type: DataTypes.STRING(255), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'testimonial_media',
    indexes: [{ fields: ['testimonialId'] }],
  }
);

module.exports = TestimonialMedia;

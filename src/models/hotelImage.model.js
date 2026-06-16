const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const HotelImage = sequelize.define(
  'HotelImage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    hotelId: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(500), allowNull: false },
    caption: { type: DataTypes.STRING(255), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'hotel_images',
    indexes: [{ fields: ['hotelId'] }],
  }
);

module.exports = HotelImage;

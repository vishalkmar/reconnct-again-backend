const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const AvailableRoomImage = sequelize.define(
  'AvailableRoomImage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    roomId: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(500), allowNull: false },
    caption: { type: DataTypes.STRING(255), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'available_room_images',
    indexes: [{ fields: ['roomId'] }],
  }
);

module.exports = AvailableRoomImage;

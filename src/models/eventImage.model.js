const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const EventImage = sequelize.define(
  'EventImage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    eventId: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(500), allowNull: false },
    caption: { type: DataTypes.STRING(255), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'event_images',
    indexes: [{ fields: ['eventId'] }],
  }
);

module.exports = EventImage;

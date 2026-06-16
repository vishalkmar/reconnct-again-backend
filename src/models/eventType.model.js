const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const EventType = sequelize.define(
  'EventType',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    // Marks types that need hour-slot booking (e.g. "cricket-box", "sports")
    isSport: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'When true, events of this type get an hour-slot booking widget',
    },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'event_types',
    indexes: [
      { name: 'event_types_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = EventType;

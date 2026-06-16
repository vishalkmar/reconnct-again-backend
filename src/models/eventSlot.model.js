const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * Hourly slot bookings for sport-type events. An event can have many slots
 * spread across multiple dates. The pair (eventId, date, startTime, sportName)
 * is treated as the natural key.
 */
const EventSlot = sequelize.define(
  'EventSlot',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    eventId: { type: DataTypes.INTEGER, allowNull: false },

    sportName: {
      type: DataTypes.STRING(120),
      allowNull: true,
      comment: 'Which sub-sport this slot is for (matches Event.sports[].name)',
    },

    slotDate: { type: DataTypes.DATEONLY, allowNull: false },
    startTime: { type: DataTypes.STRING(8), allowNull: false, comment: 'HH:mm' },
    endTime: { type: DataTypes.STRING(8), allowNull: false, comment: 'HH:mm' },

    capacity: { type: DataTypes.INTEGER, defaultValue: 10 },
    bookedCount: { type: DataTypes.INTEGER, defaultValue: 0 },

    price: { type: DataTypes.DECIMAL(12, 2), allowNull: true, comment: 'Override slot price' },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'event_slots',
    indexes: [
      { fields: ['eventId'] },
      { fields: ['slotDate'] },
      { fields: ['sportName'] },
    ],
  }
);

module.exports = EventSlot;

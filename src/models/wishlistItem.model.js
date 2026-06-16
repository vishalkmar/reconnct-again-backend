const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const WishlistItem = sequelize.define(
  'WishlistItem',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    entityType: {
      type: DataTypes.ENUM('package', 'room', 'event', 'addon'),
      allowNull: false,
      comment: 'Polymorphic — which bookable model does entityId reference',
    },
    entityId: { type: DataTypes.INTEGER, allowNull: false },
  },
  {
    tableName: 'wishlist_items',
    indexes: [
      // One row per (user, entityType, entityId) — toggling is idempotent.
      { name: 'wishlist_user_entity_unique', unique: true, fields: ['userId', 'entityType', 'entityId'] },
      { fields: ['userId'] },
      { fields: ['entityType', 'entityId'] },
    ],
  }
);

module.exports = WishlistItem;

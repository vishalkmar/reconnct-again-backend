const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// One support thread per (queue, party). `queue` decides which admin tab it
// shows under. A single app account can own BOTH a 'user' thread and a
// 'supplier' thread (host mode reuses the same User id). `supplierId` is
// reserved for a future website supplier login and stays null for app hosts.
const SupportConversation = sequelize.define(
  'SupportConversation',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    queue: { type: DataTypes.ENUM('user', 'supplier'), allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    supplierId: { type: DataTypes.INTEGER, allowNull: true },
    subjectLabel: { type: DataTypes.STRING, allowNull: true },
    subjectEmail: { type: DataTypes.STRING, allowNull: true },
    subjectPhone: { type: DataTypes.STRING, allowNull: true },
    lastMessageText: { type: DataTypes.STRING(500), allowNull: true },
    lastMessageAt: { type: DataTypes.DATE, allowNull: true },
    lastSenderRole: { type: DataTypes.ENUM('user', 'supplier', 'admin'), allowNull: true },
    unreadAdmin: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unreadParty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
  },
  {
    tableName: 'support_conversations',
    // NULLs don't collide in a MySQL unique index, so a 'user' row (supplierId
    // null) and a 'supplier' row (userId null) never clash.
    indexes: [
      { unique: true, fields: ['queue', 'userId'] },
      { unique: true, fields: ['queue', 'supplierId'] },
      { fields: ['lastMessageAt'] },
    ],
  }
);

module.exports = SupportConversation;

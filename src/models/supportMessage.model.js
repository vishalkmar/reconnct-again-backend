const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// A single message inside a SupportConversation. `senderRole` says who wrote it;
// `senderUserId` is set for user/host messages, `senderAdminId` for admin
// replies. `attachments` holds [{ type:'image'|'pdf', url, name, size }].
const SupportMessage = sequelize.define(
  'SupportMessage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    conversationId: { type: DataTypes.INTEGER, allowNull: false },
    senderRole: { type: DataTypes.ENUM('user', 'supplier', 'admin'), allowNull: false },
    senderUserId: { type: DataTypes.INTEGER, allowNull: true },
    senderAdminId: { type: DataTypes.INTEGER, allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: true },
    attachments: { type: DataTypes.JSON, allowNull: true },
    readByAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    readByParty: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: 'support_messages',
    indexes: [{ fields: ['conversationId', 'createdAt'] }],
  }
);

module.exports = SupportMessage;

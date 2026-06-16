const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Free-form discussion between an Auditor and the assigned Officer, scoped
// to a property and optionally to a section. sectionKey == null means
// "general / final suggestion box".

const Message = sequelize.define(
  'Message',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    propertyId: { type: DataTypes.INTEGER, allowNull: false },
    senderId: { type: DataTypes.INTEGER, allowNull: false },
    senderType: {
      type: DataTypes.ENUM('auditor', 'officer'),
      allowNull: false,
    },
    sectionKey: { type: DataTypes.STRING(40), allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: false },
  },
  {
    tableName: 'pwa_messages',
    indexes: [
      { fields: ['propertyId', 'createdAt'] },
      { fields: ['propertyId', 'sectionKey'] },
    ],
  }
);

module.exports = Message;

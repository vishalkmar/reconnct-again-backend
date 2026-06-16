const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// One row per recipient per event. The same backend event (e.g. an officer
// raising an objection) typically creates a single notification for the
// auditor; some events fan out to multiple recipients (a property re-upload
// might notify both the assigned officer and the property owner).

const Notification = sequelize.define(
  'Notification',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    recipientType: {
      type: DataTypes.ENUM('auditor', 'officer', 'owner', 'salesperson'),
      allowNull: false,
    },
    recipientId: { type: DataTypes.INTEGER, allowNull: false },
    // Event type — kept loose on purpose so adding a new emission point
    // doesn't need a migration. Examples: 'section_objection',
    // 'section_approved_objection', 'section_approved', 'section_reupload',
    // 'property_submitted', 'property_approved', 'property_rejected',
    // 'contract_generated', 'contract_sent_to_owner', 'contract_signed'.
    type: { type: DataTypes.STRING(60), allowNull: false },
    title: { type: DataTypes.STRING(180), allowNull: false },
    body: { type: DataTypes.STRING(500), allowNull: true },
    propertyId: { type: DataTypes.INTEGER, allowNull: true },
    data: { type: DataTypes.JSON, defaultValue: {} },
    readAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_notifications',
    indexes: [
      { fields: ['recipientType', 'recipientId', 'readAt'] },
      { fields: ['propertyId'] },
      { fields: ['createdAt'] },
    ],
  }
);

module.exports = Notification;

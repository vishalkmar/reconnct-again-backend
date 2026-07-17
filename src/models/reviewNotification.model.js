const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  A real-time notification in the experience-review pipeline.

  Recipients are polymorphic because the parties differ:
    - 'team'     → a TeamMember (COPS gets "back in queue" pings, a BD gets
                   follow-up/objection pings, a QCOPS gets escalation pings)
    - 'user'     → a Host (a User in "Switch to Hosting" mode)
    - 'supplier' → a Supplier's own login

  `kind` drives the icon/colour on the client. `meta` carries the section
  objections / suggestion / counts so the notification is fully clickable
  and self-describing without another fetch.
*/
const ReviewNotification = sequelize.define(
  'ReviewNotification',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    recipientType: { type: DataTypes.ENUM('team', 'user', 'supplier'), allowNull: false },
    recipientId: { type: DataTypes.INTEGER, allowNull: false },
    experienceId: { type: DataTypes.INTEGER, allowNull: true },
    // objection | follow_up | approved | rejected | qcops | resubmitted | submitted
    kind: { type: DataTypes.STRING(24), allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: true },
    meta: { type: DataTypes.JSON, allowNull: true },
    readAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'review_notifications',
    indexes: [
      { fields: ['recipientType', 'recipientId', 'readAt'] },
      { fields: ['experienceId'] },
    ],
  }
);

module.exports = ReviewNotification;

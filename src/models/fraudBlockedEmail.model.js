const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  The fraud "freeze list", keyed by EMAIL (not user id).

  Keying on the email means a frozen account can neither log in NOR re-register
  a fresh account with the same email — the OTP request path checks this list
  before ever issuing a code (services/fraudDetection.isEmailBlocked). Only an
  admin can lift a freeze (isActive → false), which re-opens login.

  Separate from user.isActive on purpose: a user row may not even exist yet, and
  we want the block to survive account deletion / re-signup attempts.
*/
const FraudBlockedEmail = sequelize.define(
  'FraudBlockedEmail',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(180), allowNull: false },
    reason: { type: DataTypes.STRING(255), allowNull: true },
    bookingCode: { type: DataTypes.STRING(40), allowNull: true },
    fraudEventId: { type: DataTypes.INTEGER, allowNull: true },
    // true = currently frozen. Admin unfreeze flips it to false + stamps unfrozen*.
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    frozenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    unfrozenAt: { type: DataTypes.DATE, allowNull: true },
    unfrozenByAdminId: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: 'fraud_blocked_emails',
    indexes: [
      { name: 'fraud_blocked_emails_email_unique', unique: true, fields: ['email'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = FraudBlockedEmail;

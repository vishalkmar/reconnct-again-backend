const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const OtpToken = sequelize.define(
  'OtpToken',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    target: {
      type: DataTypes.ENUM('auditor', 'officer', 'owner'),
      allowNull: false,
    },
    purpose: {
      type: DataTypes.ENUM('signup_verify', 'login', 'reset', 'owner_login'),
      allowNull: false,
    },
    email: { type: DataTypes.STRING(180), allowNull: false },
    propertyCode: { type: DataTypes.STRING(40), allowNull: true },
    codeHash: { type: DataTypes.STRING(120), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
    attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
    ipAddress: { type: DataTypes.STRING(64), allowNull: true },
  },
  {
    tableName: 'pwa_otp_tokens',
    indexes: [
      { fields: ['email', 'target', 'purpose'] },
      { fields: ['expiresAt'] },
    ],
  }
);

module.exports = OtpToken;

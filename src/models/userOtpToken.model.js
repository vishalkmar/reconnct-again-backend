const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserOtpToken = sequelize.define(
  'UserOtpToken',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(180), allowNull: false },
    purpose: {
      type: DataTypes.ENUM('login_signup'),
      allowNull: false,
      defaultValue: 'login_signup',
    },
    codeHash: { type: DataTypes.STRING(120), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
    attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
    ipAddress: { type: DataTypes.STRING(64), allowNull: true },
  },
  {
    tableName: 'user_otp_tokens',
    indexes: [
      { fields: ['email', 'purpose'] },
      { fields: ['expiresAt'] },
    ],
  }
);

module.exports = UserOtpToken;

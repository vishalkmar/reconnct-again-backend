const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Property Owners do not get a password. They authenticate by entering their
// propertyCode + the email the auditor recorded, receive an OTP, and a
// short-lived session token is issued. One row per unique email.

const PropertyOwner = sequelize.define(
  'PropertyOwner',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: true },
    email: {
      type: DataTypes.STRING(180),
      allowNull: false,
      validate: { isEmail: true },
    },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_property_owners',
    indexes: [
      { name: 'pwa_owners_email_unique', unique: true, fields: ['email'] },
    ],
  }
);

PropertyOwner.prototype.toSafeJSON = function () {
  return this.toJSON();
};

module.exports = PropertyOwner;

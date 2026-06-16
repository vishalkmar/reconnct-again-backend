const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../../config/database');

const Officer = sequelize.define(
  'Officer',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    email: {
      type: DataTypes.STRING(180),
      allowNull: false,
      validate: { isEmail: true },
    },
    password: { type: DataTypes.STRING(255), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    dob: { type: DataTypes.DATEONLY, allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    profilePhotoUrl: { type: DataTypes.STRING(500), allowNull: true },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    createdByAdminId: { type: DataTypes.INTEGER, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_officers',
    indexes: [
      { name: 'pwa_officers_email_unique', unique: true, fields: ['email'] },
      { fields: ['isActive'] },
    ],
    hooks: {
      beforeCreate: async (row) => {
        if (row.password) row.password = await bcrypt.hash(row.password, 10);
      },
      beforeUpdate: async (row) => {
        if (row.changed('password')) row.password = await bcrypt.hash(row.password, 10);
      },
    },
  }
);

Officer.prototype.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

Officer.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.password;
  return obj;
};

module.exports = Officer;

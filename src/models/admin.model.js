const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');

const Admin = sequelize.define(
  'Admin',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(160),
      allowNull: false,
      validate: { isEmail: true },
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('superadmin', 'admin', 'editor'),
      defaultValue: 'admin',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'admins',
    indexes: [
      { name: 'admins_email_unique', unique: true, fields: ['email'] },
    ],
    hooks: {
      beforeCreate: async (admin) => {
        if (admin.password) {
          admin.password = await bcrypt.hash(admin.password, 10);
        }
      },
      beforeUpdate: async (admin) => {
        if (admin.changed('password')) {
          admin.password = await bcrypt.hash(admin.password, 10);
        }
      },
    },
  }
);

Admin.prototype.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

Admin.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.password;
  return obj;
};

module.exports = Admin;

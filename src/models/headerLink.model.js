const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const HeaderLink = sequelize.define(
  'HeaderLink',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    label: { type: DataTypes.STRING(120), allowNull: false },
    path: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: 'Internal path like /retreats or full URL like https://...',
    },
    target: {
      type: DataTypes.ENUM('_self', '_blank'),
      defaultValue: '_self',
    },
    icon: { type: DataTypes.STRING(80), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'header_links',
    indexes: [{ fields: ['isActive'] }, { fields: ['sortOrder'] }],
  }
);

module.exports = HeaderLink;

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Generic key/value store for site-wide settings (theme, contact info, etc.).
  `value` is JSON so any shape can be stored.
*/
const SiteSetting = sequelize.define(
  'SiteSetting',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    key: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    value: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    tableName: 'site_settings',
    indexes: [
      { name: 'site_settings_key_unique', unique: true, fields: ['key'] },
    ],
  }
);

module.exports = SiteSetting;

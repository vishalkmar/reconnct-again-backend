const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PackageImage = sequelize.define(
  'PackageImage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    packageId: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(500), allowNull: false },
    caption: { type: DataTypes.STRING(255), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'package_images',
    indexes: [{ fields: ['packageId'] }],
  }
);

module.exports = PackageImage;

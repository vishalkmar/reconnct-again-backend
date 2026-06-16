const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Area = sequelize.define(
  'Area',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'areas',
    indexes: [
      { name: 'areas_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = Area;

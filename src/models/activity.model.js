const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Activity = sequelize.define(
  'Activity',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    slug: { type: DataTypes.STRING(140), allowNull: false },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    icon: { type: DataTypes.STRING(80), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'activities',
    indexes: [
      { name: 'activities_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = Activity;

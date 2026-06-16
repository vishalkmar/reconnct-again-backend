const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Facility = sequelize.define(
  'Facility',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },
    icon: {
      type: DataTypes.STRING(120),
      allowNull: true,
      comment: 'Optional lucide / fa icon name for inline display',
    },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'facilities',
    indexes: [
      { name: 'facilities_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = Facility;

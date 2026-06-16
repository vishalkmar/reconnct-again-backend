const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const BlogCategory = sequelize.define(
  'BlogCategory',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    slug: { type: DataTypes.STRING(140), allowNull: false },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'blog_categories',
    indexes: [
      { name: 'blog_categories_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = BlogCategory;

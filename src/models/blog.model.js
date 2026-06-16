const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Blog = sequelize.define(
  'Blog',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    title: { type: DataTypes.STRING(255), allowNull: false },
    slug: { type: DataTypes.STRING(280), allowNull: false },

    excerpt: { type: DataTypes.TEXT('long'), allowNull: true },
    content: { type: DataTypes.TEXT('long'), allowNull: true },

    featuredImage: { type: DataTypes.STRING(500), allowNull: true },

    blogCategoryId: { type: DataTypes.INTEGER, allowNull: true },

    authorName: { type: DataTypes.STRING(160), allowNull: true },
    authorTitle: { type: DataTypes.STRING(160), allowNull: true },
    authorImage: { type: DataTypes.STRING(500), allowNull: true },

    tags: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of tag strings',
    },

    readMinutes: { type: DataTypes.INTEGER, defaultValue: 5 },
    viewCount: { type: DataTypes.INTEGER, defaultValue: 0 },

    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    isPublished: { type: DataTypes.BOOLEAN, defaultValue: false },
    publishedAt: { type: DataTypes.DATE, allowNull: true },

    metaTitle: { type: DataTypes.STRING(255), allowNull: true },
    metaDescription: { type: DataTypes.STRING(500), allowNull: true },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'blogs',
    indexes: [
      { name: 'blogs_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isPublished'] },
      { fields: ['isFeatured'] },
      { fields: ['blogCategoryId'] },
      { fields: ['publishedAt'] },
    ],
  }
);

module.exports = Blog;

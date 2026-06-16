const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  BlogScene — a single "section" within a blog article.
  Each blog can have many scenes; each scene has its own image, title and text.
  Renders as a timeline-style chapter on the public detail page (similar to
  Holidays Seychelles travel blog layout).
*/
const BlogScene = sequelize.define(
  'BlogScene',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    blogId: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: true },
    subtitle: { type: DataTypes.STRING(255), allowNull: true },
    content: { type: DataTypes.TEXT('long'), allowNull: true, comment: 'HTML or plain text' },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    imagePosition: {
      type: DataTypes.ENUM('left', 'right', 'top', 'bottom', 'full'),
      defaultValue: 'left',
      comment: 'How image is laid out relative to text on detail page',
    },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'blog_scenes',
    indexes: [{ fields: ['blogId'] }],
  }
);

module.exports = BlogScene;

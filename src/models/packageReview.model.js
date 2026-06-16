const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PackageReview = sequelize.define(
  'PackageReview',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    packageId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(160), allowNull: true },
    rating: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
    title: { type: DataTypes.STRING(160), allowNull: true },
    comment: { type: DataTypes.TEXT, allowNull: true },
    avatarUrl: { type: DataTypes.STRING(500), allowNull: true },
    isApproved: { type: DataTypes.BOOLEAN, defaultValue: false },
  },
  {
    tableName: 'package_reviews',
    indexes: [{ fields: ['packageId'] }, { fields: ['isApproved'] }],
  }
);

module.exports = PackageReview;

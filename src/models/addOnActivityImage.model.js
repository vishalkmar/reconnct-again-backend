const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const AddOnActivityImage = sequelize.define(
  'AddOnActivityImage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    activityId: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(500), allowNull: false },
    caption: { type: DataTypes.STRING(255), allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'add_on_activity_images',
    indexes: [{ fields: ['activityId'] }],
  }
);

module.exports = AddOnActivityImage;

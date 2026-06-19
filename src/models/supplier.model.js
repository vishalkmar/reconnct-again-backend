const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Supplier — the partner/vendor that runs experiences. An Experience optionally
  belongs to one Supplier (supplierId FK on the experience). Created & managed
  from the admin "Suppliers" tab (CRUD).
*/
const Supplier = sequelize.define(
  'Supplier',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    companyName: { type: DataTypes.STRING(240), allowNull: false },
    supplierName: { type: DataTypes.STRING(240), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    email: { type: DataTypes.STRING(200), allowNull: true },
    image: { type: DataTypes.STRING(500), allowNull: true },       // logo / photo (optional)
    b2bContract: { type: DataTypes.STRING(500), allowNull: true },  // uploaded contract URL (optional)
    notes: { type: DataTypes.TEXT, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'suppliers',
    indexes: [
      { fields: ['isActive'] },
      { fields: ['companyName'] },
    ],
  }
);

module.exports = Supplier;

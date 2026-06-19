const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Contract — a B2B service agreement between the portal (operator, from the
  company profile) and a Supplier. Captures point-in-time snapshots of both
  parties + the supplier's selected activities with their negotiated B2B prices,
  plus free-text intro & signing formalities. PDF / Word are generated on the fly
  from this record at download time.
*/
const Contract = sequelize.define(
  'Contract',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    supplierId: { type: DataTypes.INTEGER, allowNull: true },
    title: { type: DataTypes.STRING(240), allowNull: false, defaultValue: 'Service Agreement' },
    // Snapshots so the contract reads the same even if the supplier / profile change later.
    operatorSnapshot: { type: DataTypes.JSON, allowNull: true },
    supplierSnapshot: { type: DataTypes.JSON, allowNull: true },
    intro: { type: DataTypes.TEXT('long'), allowNull: true },        // contract body text
    formalities: { type: DataTypes.TEXT('long'), allowNull: true },  // signing / terms text
    // [{ experienceId, name, b2bPrice, include }] — only include:true with a price print.
    items: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    status: { type: DataTypes.ENUM('draft', 'generated'), defaultValue: 'draft' },
  },
  {
    tableName: 'contracts',
    indexes: [
      { fields: ['supplierId'] },
      { fields: ['status'] },
    ],
  }
);

module.exports = Contract;

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Contract = sequelize.define(
  'Contract',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    propertyId: { type: DataTypes.INTEGER, allowNull: false },
    generatedPdfUrl: { type: DataTypes.STRING(500), allowNull: true },
    signedPdfUrl: { type: DataTypes.STRING(500), allowNull: true },
    signedOriginalName: { type: DataTypes.STRING(255), allowNull: true },
    signedMimeType: { type: DataTypes.STRING(120), allowNull: true },
    finalPdfUrl: { type: DataTypes.STRING(500), allowNull: true },
    finalOriginalName: { type: DataTypes.STRING(255), allowNull: true },
    finalMimeType: { type: DataTypes.STRING(120), allowNull: true },
    // When the officer generated the PDF — at this point the contract is
    // "with the auditor" but the owner has not been emailed yet.
    generatedAt: { type: DataTypes.DATE, allowNull: true },
    // When the auditor pressed "Send to owner" — owner notification fires
    // and they become eligible to view + sign the contract.
    sentAt: { type: DataTypes.DATE, allowNull: true },
    releasedByAuditorId: { type: DataTypes.INTEGER, allowNull: true },
    signedAt: { type: DataTypes.DATE, allowNull: true },
    ownerSignedByEmail: { type: DataTypes.STRING(180), allowNull: true },
    finalSignedAt: { type: DataTypes.DATE, allowNull: true },
    finalSignedByOfficerId: { type: DataTypes.INTEGER, allowNull: true },
    finalSentToAuditorAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_contracts',
    indexes: [
      { name: 'pwa_contracts_property_unique', unique: true, fields: ['propertyId'] },
    ],
  }
);

module.exports = Contract;

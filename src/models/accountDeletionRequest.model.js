const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  A traveller asking for their account to be deleted.

  Deletion is NOT immediate: the request lands here, an admin sees it in
  Users → Deletion requests, and approves it. That keeps a human in the loop for
  an irreversible action and leaves an audit trail of who removed what and when.

  Google Play only requires that the user can *request* deletion from inside the
  app and from a public web page — both of which create a row here.
*/
const AccountDeletionRequest = sequelize.define(
  'AccountDeletionRequest',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    // Copied at request time so the admin list still reads correctly after the
    // account is anonymised — the user row no longer holds any of this.
    email: { type: DataTypes.STRING(180), allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: true },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    source: {
      type: DataTypes.ENUM('app', 'web', 'public'),
      allowNull: false,
      defaultValue: 'public',
      comment: 'app = mobile profile, web = member portal, public = the /delete-account page',
    },
    reason: { type: DataTypes.STRING(500), allowNull: true },
    status: {
      type: DataTypes.ENUM('pending', 'completed', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
    },
    handledByAdminId: { type: DataTypes.INTEGER, allowNull: true },
    handledAt: { type: DataTypes.DATE, allowNull: true },
    adminNote: { type: DataTypes.STRING(500), allowNull: true },
  },
  {
    tableName: 'account_deletion_requests',
    indexes: [
      { fields: ['status', 'createdAt'] },
      { fields: ['userId'] },
      { fields: ['email'] },
    ],
  }
);

module.exports = AccountDeletionRequest;

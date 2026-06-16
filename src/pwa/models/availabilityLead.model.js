const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

/*
  One row per Check-Availability submission from the public website.

  Lifecycle:
    pending          → just submitted, both owner & salesperson notified
    owner_yes        → owner confirmed the date
    owner_no         → owner declined the date — salesperson can re-request another date
    not_converted    → salesperson dropped the lead (with `lostReason`)
    converted        → manually marked closed-won (future use)

  Re-requests don't overwrite the original; a new lead row is inserted with
  `parentLeadId` pointing back to the original so the salesperson can see
  the full chain.
*/

const LEAD_STATUS = [
  'pending',
  'owner_yes',
  'owner_no',
  'not_converted',
  'converted',
];

const AvailabilityLead = sequelize.define(
  'AvailabilityLead',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // The package the customer is enquiring about
    packageId: { type: DataTypes.INTEGER, allowNull: false },

    // Assignments — snapshotted at lead creation so re-assignments don't
    // retroactively change history.
    ownerId:        { type: DataTypes.INTEGER, allowNull: true }, // pwa_property_owners
    salespersonId:  { type: DataTypes.INTEGER, allowNull: true }, // pwa_salespersons

    // Customer details from the form
    customerName:  { type: DataTypes.STRING(160), allowNull: false },
    customerPhone: { type: DataTypes.STRING(30),  allowNull: false },
    customerEmail: { type: DataTypes.STRING(180), allowNull: true },
    requestedDate: { type: DataTypes.DATEONLY,    allowNull: false },
    notes:         { type: DataTypes.TEXT,        allowNull: true },

    status: {
      type: DataTypes.ENUM(...LEAD_STATUS),
      defaultValue: 'pending',
    },

    // Owner decision
    ownerRespondedAt: { type: DataTypes.DATE, allowNull: true },
    ownerNote:        { type: DataTypes.TEXT, allowNull: true },

    // Salesperson outcome
    closedBySalespersonAt: { type: DataTypes.DATE, allowNull: true },
    lostReason: { type: DataTypes.TEXT, allowNull: true },

    // Re-request chain (when owner says no, salesperson can submit another
    // date — that becomes a new lead pointing back here)
    parentLeadId: { type: DataTypes.INTEGER, allowNull: true },
    iteration:    { type: DataTypes.INTEGER, defaultValue: 1 },

    // Stub flags for the dummy voice-call dispatch
    ownerCallQueuedAt:        { type: DataTypes.DATE, allowNull: true },
    salespersonCallQueuedAt:  { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_availability_leads',
    indexes: [
      { fields: ['packageId'] },
      { fields: ['ownerId'] },
      { fields: ['salespersonId'] },
      { fields: ['status'] },
      { fields: ['parentLeadId'] },
    ],
  }
);

AvailabilityLead.STATUS = LEAD_STATUS;

module.exports = AvailabilityLead;

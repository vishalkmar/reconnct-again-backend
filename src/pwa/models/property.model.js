const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Property = sequelize.define(
  'Property',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Human-readable code shown across the app: "RTV-AB12CD34". Generated
    // once at Phase 2 lock-in and never changes — this is what the user
    // refers to as the "Property ID".
    propertyCode: { type: DataTypes.STRING(40), allowNull: true },

    // Nullable now: a property may be onboarded by the owner directly
    // ("self" source) in which case there is no auditor in the loop.
    auditorId: { type: DataTypes.INTEGER, allowNull: true },
    assignedOfficerId: { type: DataTypes.INTEGER, allowNull: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true },
    // Who initiated this property — drives visibility on each role's
    // dashboard and skips the auditor's "release contract" step when the
    // owner is self-serving.
    source: {
      type: DataTypes.ENUM('auditor', 'self'),
      defaultValue: 'auditor',
      allowNull: false,
    },

    // Phase 1 fields
    name: { type: DataTypes.STRING(220), allowNull: false },
    address: { type: DataTypes.TEXT, allowNull: false },
    locationMode: {
      type: DataTypes.ENUM('manual', 'pinned'),
      defaultValue: 'manual',
    },
    locationText: { type: DataTypes.STRING(255), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    ownerName: { type: DataTypes.STRING(160), allowNull: false },
    ownerEmail: {
      type: DataTypes.STRING(180),
      allowNull: false,
      validate: { isEmail: true },
    },
    ownerPhone: { type: DataTypes.STRING(20), allowNull: true },
    numberOfRooms: { type: DataTypes.INTEGER, allowNull: true },
    pricing: { type: DataTypes.STRING(120), allowNull: true },

    // Lifecycle
    status: {
      type: DataTypes.ENUM(
        'draft',
        'phase1_done',
        'phase3_submitted',
        'in_review',
        'in_revision',
        // Phase 3 approved — conceptually "semi-approved". Phase 4 deep-dive
        // pending before the contract is generated.
        'approved',
        'phase4_submitted',
        'phase4_in_revision',
        // All four phases reviewed and accepted; contract gen happens here.
        'final_approved',
        'rejected',
        'contract_sent',
        'contract_signed',
        'completed'
      ),
      defaultValue: 'draft',
    },
    phase: { type: DataTypes.INTEGER, defaultValue: 1 },

    // Officer outputs
    officerSuggestion: { type: DataTypes.TEXT, allowNull: true },
    rejectedReason: { type: DataTypes.TEXT, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },       // Phase 3 approval
    finalApprovedAt: { type: DataTypes.DATE, allowNull: true },  // Phase 4 approval
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    phase4SubmittedAt: { type: DataTypes.DATE, allowNull: true },

    // Set when the central officer presses "List on website now" — this moves
    // the property into the admin's listing-configuration queue.
    listingSubmittedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'pwa_properties',
    indexes: [
      { name: 'pwa_properties_code_unique', unique: true, fields: ['propertyCode'] },
      { fields: ['auditorId'] },
      { fields: ['assignedOfficerId'] },
      { fields: ['ownerEmail'] },
      { fields: ['status'] },
    ],
  }
);

module.exports = Property;

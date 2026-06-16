// PWA model registry + associations. Imported from backend/src/models/index.js
// so that everything lives behind a single `require('../models')` for the
// existing website code while staying isolated by table prefix `pwa_*`.

const Auditor = require('./auditor.model');
const Officer = require('./officer.model');
const PropertyOwner = require('./propertyOwner.model');
const OtpToken = require('./otpToken.model');
const Property = require('./property.model');
const PropertyField = require('./propertyField.model');
const FieldReview = require('./fieldReview.model');
const Message = require('./message.model');
const Contract = require('./contract.model');
const ListingImage = require('./listingImage.model');
const Salesperson = require('./salesperson.model');
const AvailabilityLead = require('./availabilityLead.model');
const VoiceCallLog = require('./voiceCallLog.model');
const PropertyPhase4Data = require('./propertyPhase4Data.model');
const Notification = require('./notification.model');
const PwaListingConfig = require('./listingConfig.model');

// Property <-> Auditor
Property.belongsTo(Auditor, { foreignKey: 'auditorId', as: 'auditor' });
Auditor.hasMany(Property, { foreignKey: 'auditorId', as: 'properties' });

// Property <-> Officer
Property.belongsTo(Officer, { foreignKey: 'assignedOfficerId', as: 'officer' });
Officer.hasMany(Property, { foreignKey: 'assignedOfficerId', as: 'properties' });

// Property <-> Owner
Property.belongsTo(PropertyOwner, { foreignKey: 'ownerId', as: 'owner' });
PropertyOwner.hasMany(Property, { foreignKey: 'ownerId', as: 'properties' });

// Property <-> Fields
Property.hasMany(PropertyField, { foreignKey: 'propertyId', as: 'fields', onDelete: 'CASCADE' });
PropertyField.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });

// Property <-> Field Reviews
Property.hasMany(FieldReview, { foreignKey: 'propertyId', as: 'reviews', onDelete: 'CASCADE' });
FieldReview.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });

// Property <-> Messages
Property.hasMany(Message, { foreignKey: 'propertyId', as: 'messages', onDelete: 'CASCADE' });
Message.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });

// Property <-> Contract (1:1)
Property.hasOne(Contract, { foreignKey: 'propertyId', as: 'contract', onDelete: 'CASCADE' });
Contract.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });

// Property <-> Listing Images (1:many)
Property.hasMany(ListingImage, { foreignKey: 'propertyId', as: 'listingImages', onDelete: 'CASCADE' });
ListingImage.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });

// ListingImage <-> Auditor
Auditor.hasMany(ListingImage, { foreignKey: 'auditorId', as: 'listingImages' });
ListingImage.belongsTo(Auditor, { foreignKey: 'auditorId', as: 'auditor' });

// AvailabilityLead <-> PropertyOwner & Salesperson
PropertyOwner.hasMany(AvailabilityLead, { foreignKey: 'ownerId', as: 'leads' });
AvailabilityLead.belongsTo(PropertyOwner, { foreignKey: 'ownerId', as: 'owner' });

Salesperson.hasMany(AvailabilityLead, { foreignKey: 'salespersonId', as: 'leads' });
AvailabilityLead.belongsTo(Salesperson, { foreignKey: 'salespersonId', as: 'salesperson' });

// Lead re-request chain — self-referencing
AvailabilityLead.hasMany(AvailabilityLead, { foreignKey: 'parentLeadId', as: 'followUps' });
AvailabilityLead.belongsTo(AvailabilityLead, { foreignKey: 'parentLeadId', as: 'parent' });

// VoiceCallLog <-> AvailabilityLead
AvailabilityLead.hasMany(VoiceCallLog, { foreignKey: 'leadId', as: 'voiceCalls', onDelete: 'CASCADE' });
VoiceCallLog.belongsTo(AvailabilityLead, { foreignKey: 'leadId', as: 'lead' });

// Phase 4 data <-> Property
Property.hasMany(PropertyPhase4Data, { foreignKey: 'propertyId', as: 'phase4', onDelete: 'CASCADE' });
PropertyPhase4Data.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });

// Property <-> Website listing config (1:1)
Property.hasOne(PwaListingConfig, { foreignKey: 'propertyId', as: 'listingConfig', onDelete: 'CASCADE' });
PwaListingConfig.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });

module.exports = {
  Auditor,
  Officer,
  PropertyOwner,
  OtpToken,
  Property,
  PropertyField,
  FieldReview,
  Message,
  Contract,
  ListingImage,
  Salesperson,
  AvailabilityLead,
  VoiceCallLog,
  PropertyPhase4Data,
  Notification,
  PwaListingConfig,
};

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

/*
  Dummy voice-call log. The real Twilio / Exotel integration goes in the
  service layer (services/voiceCall.js); for now each "fired" call inserts
  a row here so the admin can audit who was rung when.
*/
const VoiceCallLog = sequelize.define(
  'VoiceCallLog',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    leadId: { type: DataTypes.INTEGER, allowNull: true },

    // 'owner' | 'salesperson' | 'customer'
    recipientRole: { type: DataTypes.STRING(40), allowNull: false },
    recipientPhone: { type: DataTypes.STRING(30), allowNull: false },
    recipientName: { type: DataTypes.STRING(160), allowNull: true },

    // What the dummy voice said. Real provider replaces with TwiML / TTS.
    scriptText: { type: DataTypes.TEXT, allowNull: true },

    // 'queued' | 'delivered' | 'failed'  (dummy provider always 'queued')
    status: { type: DataTypes.STRING(20), defaultValue: 'queued' },

    provider: { type: DataTypes.STRING(40), defaultValue: 'dummy' },
    providerSid: { type: DataTypes.STRING(120), allowNull: true },
    errorMessage: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: 'pwa_voice_call_logs',
    indexes: [
      { fields: ['leadId'] },
      { fields: ['recipientRole'] },
      { fields: ['status'] },
    ],
  }
);

module.exports = VoiceCallLog;

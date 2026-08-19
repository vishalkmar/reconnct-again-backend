const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  A detected payment-fraud event.

  Raised when a booking is CONFIRMED but the amount Cashfree actually collected
  is materially LESS than the amount the server computed the booking should cost
  (the classic Burp/MITM "tamper the gateway amount" attack). Everything the
  admin needs to investigate + act is snapshotted here so the record stands on
  its own even if the booking/user later changes.

  This table is written ONLY by the fraud-detection service and read by the
  admin Security dashboard — it never sits in any customer-facing path, so it
  can't affect a normal booking flow.
*/
const FraudEvent = sequelize.define(
  'FraudEvent',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Who + which booking (denormalised so the row is self-contained).
    userId: { type: DataTypes.INTEGER, allowNull: true },
    userEmail: { type: DataTypes.STRING(180), allowNull: true },
    userName: { type: DataTypes.STRING(160), allowNull: true },
    userPhone: { type: DataTypes.STRING(40), allowNull: true },

    bookingId: { type: DataTypes.INTEGER, allowNull: true },
    bookingCode: { type: DataTypes.STRING(40), allowNull: true },

    // The money story — all in paise.
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },
    expectedPaise: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // what it SHOULD have cost
    paidPaise: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // what was actually collected
    shortfallPaise: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // expected − paid

    // Coupon context — a legitimate coupon is subtracted BEFORE deciding fraud,
    // so this records that it was accounted for (never a false positive).
    couponCode: { type: DataTypes.STRING(40), allowNull: true },
    couponDiscountPaise: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Why it fired + how bad.
    reason: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'amount_tampered' },
    severity: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'high' },

    // Full evidence blobs (JSON so the shape can grow without a migration).
    //   paymentDetails : { paymentId, method, bank, cfOrderId, cfOrder{…} }
    //   itemDetails    : { type, id, name, scheduledFor, bookedAt, snapshot{…} }
    //   clientContext  : { ip, userAgent, systemInfo, deviceId, location, network, capturedAt }
    paymentDetails: { type: DataTypes.JSON, allowNull: true },
    itemDetails: { type: DataTypes.JSON, allowNull: true },
    clientContext: { type: DataTypes.JSON, allowNull: true },

    // Admin workflow.
    status: { type: DataTypes.ENUM('open', 'reviewed', 'dismissed'), allowNull: false, defaultValue: 'open' },
    adminNote: { type: DataTypes.TEXT, allowNull: true },

    detectedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'fraud_events',
    indexes: [
      { fields: ['userId'] },
      { fields: ['userEmail'] },
      { fields: ['bookingCode'] },
      { fields: ['status'] },
      { fields: ['detectedAt'] },
    ],
  }
);

module.exports = FraudEvent;

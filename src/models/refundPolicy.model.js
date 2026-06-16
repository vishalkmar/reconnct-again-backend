const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Single-row table — the platform-wide DEFAULT refund policy. Individual
// items (Package / AvailableRoom / Event / AddOnActivity) may carry their
// own `refundPolicyOverride` JSON column whose shape matches `tiers` below;
// when present, the override wins. When absent, this default applies.
//
// `tiers` is an array of:
//   { hoursBeforeCheckIn: 72, refundPercent: 100, label: "..." }
//
// Resolution: sort tiers descending by hoursBeforeCheckIn, find the FIRST
// tier whose threshold <= hoursToCheckIn, that's the % to refund. So a tier
// at 24 with 0% means "less than 24 hours → no refund."
const RefundPolicy = sequelize.define(
  'RefundPolicy',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    tiers: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [
        { hoursBeforeCheckIn: 72, refundPercent: 100, label: '72+ hours before check-in' },
        { hoursBeforeCheckIn: 48, refundPercent: 50,  label: '48–72 hours before check-in' },
        { hoursBeforeCheckIn: 0,  refundPercent: 0,   label: 'Within 24 hours of check-in' },
      ],
    },

    // Kill switch — set false to disable ALL automated refunds (admin-only
    // manual handling). Booking still cancels, just no money moves.
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // Note shown to users on the cancel-confirmation step.
    processingNote: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: 'Refunds are processed instantly on our end. The amount will reflect in your original payment method within 5–7 business days.',
    },
  },
  {
    tableName: 'refund_policies',
  }
);

module.exports = RefundPolicy;

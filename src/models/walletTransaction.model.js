const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const WalletTransaction = sequelize.define(
  'WalletTransaction',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },

    // Positive = credit added (refund, referral payout, admin grant).
    // Negative = credit used (booking discount).
    // Stored in paise so it lines up with Booking.walletDiscountPaise.
    amountPaise: { type: DataTypes.INTEGER, allowNull: false },

    // Snapshot of the balance AFTER this transaction. Lets the wallet
    // history page render running balances without re-summing every row.
    balanceAfterPaise: { type: DataTypes.INTEGER, allowNull: false },

    type: {
      type: DataTypes.ENUM(
        'referral_payout',     // referrer earned credit on referee's first paid booking
        'booking_used',        // user spent credit on a booking
        'booking_refund',      // credit restored after cancellation
        'admin_adjust',        // manual credit/debit by admin (Phase 8)
        'signup_bonus'         // optional welcome credit (not used by default)
      ),
      allowNull: false,
    },

    // Loose polymorphic link — bookingId, referee userId, or null for admin
    // adjustments. We keep it deliberately untyped so future trigger types
    // don't require schema changes.
    referenceType: { type: DataTypes.STRING(40), allowNull: true },
    referenceId: { type: DataTypes.STRING(80), allowNull: true },

    description: { type: DataTypes.STRING(255), allowNull: true },
  },
  {
    tableName: 'wallet_transactions',
    indexes: [
      { fields: ['userId', 'createdAt'] },
      { fields: ['referenceType', 'referenceId'] },
    ],
  }
);

module.exports = WalletTransaction;

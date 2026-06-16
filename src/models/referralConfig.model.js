const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Single-row table — there is exactly one referral config for the platform.
// We use an `id=1` row and upsert it via the admin UI; the service layer always
// reads from id=1 (with the hard-coded defaults below as a fallback if the row
// hasn't been seeded yet).
//
// `tiers` is a JSON array of bonus rules of the shape:
//   { atCount: 3, withinDays: 10, totalPayoutPaise: 120000, label: "..." }
//
// The service evaluates them in order — the FIRST tier whose conditions hold
// (referral count equals atCount, all those referrals happened within withinDays
// of the first one) wins. If no tier matches, the flat baseAmountPaise applies.
const ReferralConfig = sequelize.define(
  'ReferralConfig',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Flat reward paid for every qualifying referral that doesn't trigger a
    // tier bonus. ₹300 by default (30000 paise).
    baseAmountPaise: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30000 },

    // Bonus tiers (see comment above for shape).
    tiers: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [
        { atCount: 3, withinDays: 10, totalPayoutPaise: 120000, label: '3 referrals within 10 days' },
      ],
    },

    // Kill switch — set false to stop ALL referral payouts (useful for hot
    // rollback if a fraud wave hits the system).
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // Anti-abuse: cap how much referral credit a user can burn on a single
    // booking. Two knobs, applied as a min() — the stricter one wins.
    //   maxPerBookingPaise → absolute cap in paise (0 = no absolute cap)
    //   maxPerBookingPct   → percent of the gross order (0 = no percent cap)
    // With both at 0 the cap is disabled and users can drain their wallet
    // in one shot (legacy behaviour). Default: at most ₹500 OR 25% of order.
    maxPerBookingPaise: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50000 },
    maxPerBookingPct:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 25 },

    // Booking-range-based redemption tiers — admin can carve the price
    // axis into bands and set a different cap per band. If a tier matches
    // the gross booking amount, its cap wins over the global knobs above.
    // Empty array (the default) keeps the legacy single-cap behaviour.
    //
    // Tier shape (paise everywhere):
    //   { minPaise: 0,       maxPaise: 200000, capPaise: 30000, capPct: 0,  label: '≤₹2,000 → ₹300' }
    //   { minPaise: 200000,  maxPaise: 500000, capPaise: 75000, capPct: 0 }
    //   { minPaise: 500000,  maxPaise: null,   capPaise: 0,     capPct: 20 }
    //
    // capPaise and capPct are AND-ed via min() per tier (same as the
    // global knobs). 0 on either knob disables that side of the cap for
    // the tier; null `maxPaise` means open-ended upper bound.
    redemptionTiers: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },

    // Free-form note shown on the user-side Refer & Earn page.
    description: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: 'Earn ₹300 each time a friend joins using your code. Get 3 friends to join within 10 days and earn ₹1,200 instead of ₹900.',
    },
  },
  {
    tableName: 'referral_configs',
  }
);

module.exports = ReferralConfig;

/**
 * Seed a ready-to-explore demo MEMBER account with real wishlist items,
 * bookings, payments/refunds and wallet history — so the user dashboard can be
 * reviewed end-to-end without manually clicking through the (not-included)
 * public booking site.
 *
 * Idempotent: re-running wipes & rebuilds this one demo user's bookings /
 * wallet / wishlist, and upserts the demo packages by slug. It never touches
 * any other user's data.
 *
 *   npm run seed:test
 */
require('dotenv').config();
const {
  sequelize,
  User,
  Package,
  Booking,
  WishlistItem,
  WalletTransaction,
} = require('../models');
const {
  fetchItem,
  buildItemSnapshot,
  computePricing,
  resolveSchedule,
  generateBookingCode,
} = require('../services/booking.service');

// The demo member logs in with email-OTP. Using a real inbox you control means
// the 6-digit code actually reaches you. Change DEMO_EMAIL if you prefer.
const DEMO_EMAIL = (process.env.DEMO_USER_EMAIL || 'vk722413@gmail.com').toLowerCase();

const IMG = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=60`;

const DEMO_PACKAGES = [
  {
    slug: 'silent-forest-yoga-ayurveda-retreat',
    name: 'Silent Forest Yoga & Ayurveda Retreat',
    primaryImage: IMG('photo-1545205597-3d9d02c29597'),
    priceFrom: 18500, priceOriginal: 22000, gstRate: 5,
    locationDetail: 'Rishikesh, Uttarakhand', durationDays: 5, durationNights: 4,
    rating: 4.9, reviewCount: 128, shortDescription: 'A 5-day immersion into yogic living, Ayurvedic healing and forest meditation.',
  },
  {
    slug: 'coffee-estate-trek-camping',
    name: 'Coffee Estate Trek & Camping',
    primaryImage: IMG('photo-1501785888041-af3ef285b470'),
    priceFrom: 9800, priceOriginal: 11500, gstRate: 5,
    locationDetail: 'Coorg, Karnataka', durationDays: 3, durationNights: 2,
    rating: 4.7, reviewCount: 64, shortDescription: 'Trek through misty coffee estates and camp under the stars.',
  },
  {
    slug: 'old-bombay-culinary-trail',
    name: 'Old Bombay Culinary Trail',
    primaryImage: IMG('photo-1504674900247-0877df9cc836'),
    priceFrom: 3200, priceOriginal: null, gstRate: 5,
    locationDetail: 'Mumbai, Maharashtra', durationDays: 1, durationNights: 0,
    rating: 4.8, reviewCount: 39, shortDescription: 'A 6-hour guided walk through heritage food districts.',
  },
];

const run = async () => {
  await sequelize.authenticate();
  console.log('[SEED:test] Connected to DB');

  // 1) Demo member ------------------------------------------------------------
  const [user] = await User.findOrCreate({
    where: { email: DEMO_EMAIL },
    defaults: { email: DEMO_EMAIL },
  });
  user.name = 'Vishal (Demo)';
  user.phone = '9540792427';
  user.isProfileComplete = true;
  user.gender = 'male';
  user.city = 'New Delhi';
  user.state = 'Delhi';
  user.country = 'India';
  user.referralCode = user.referralCode || 'RECON800';
  user.walletBalancePaise = 80000; // ₹800
  await user.save();
  console.log(`[SEED:test] Demo member ready: ${user.email} (id=${user.id})`);

  // 2) Demo packages (upsert by slug) ----------------------------------------
  const pkgs = [];
  for (const p of DEMO_PACKAGES) {
    const [pkg] = await Package.findOrCreate({ where: { slug: p.slug }, defaults: p });
    await pkg.update({ ...p, isActive: true });
    pkgs.push(pkg);
  }
  console.log(`[SEED:test] ${pkgs.length} demo packages ready`);

  // 3) Wishlist — 3 saved ------------------------------------------------------
  await WishlistItem.destroy({ where: { userId: user.id } });
  for (const pkg of pkgs) {
    await WishlistItem.create({ userId: user.id, entityType: 'package', entityId: pkg.id });
  }
  console.log('[SEED:test] Wishlist: 3 packages saved');

  // 4) Wallet history (sums to ₹800) ------------------------------------------
  await WalletTransaction.destroy({ where: { userId: user.id } });
  await WalletTransaction.create({
    userId: user.id, amountPaise: 50000, balanceAfterPaise: 50000,
    type: 'referral_payout', referenceType: 'user', referenceId: String(user.id),
    description: 'Referral reward — friend completed signup',
    createdAt: new Date('2026-04-02T10:00:00Z'),
  });
  await WalletTransaction.create({
    userId: user.id, amountPaise: 30000, balanceAfterPaise: 80000,
    type: 'admin_adjust', referenceType: 'admin', referenceId: '1',
    description: 'Goodwill credit',
    createdAt: new Date('2026-05-18T10:00:00Z'),
  });
  console.log('[SEED:test] Wallet history seeded (₹800)');

  // 5) Bookings / payments / refund -------------------------------------------
  await Booking.destroy({ where: { userId: user.id } });

  // type, packageIndex, guestCount, status, scheduledFor, paidAt, refund?
  const plan = [
    { idx: 0, guests: 2, status: 'confirmed', start: '2026-07-07', paidAt: '2026-05-10T09:30:00Z', method: 'upi' },
    { idx: 1, guests: 2, status: 'completed', start: '2026-03-20', paidAt: '2026-03-01T14:10:00Z', method: 'card' },
    { idx: 2, guests: 1, status: 'confirmed', start: '2026-08-12', paidAt: '2026-06-01T11:00:00Z', method: 'netbanking' },
    { idx: 0, guests: 1, status: 'refunded',  start: '2026-02-15', paidAt: '2026-01-20T08:00:00Z', method: 'upi', refund: true },
    { idx: 1, guests: 3, status: 'pending_payment', start: '2026-09-05', paidAt: null, method: null },
  ];

  let n = 0;
  for (const b of plan) {
    const pkg = pkgs[b.idx];
    const item = await fetchItem('package', pkg.id);
    const snapshot = buildItemSnapshot(item);
    const sched = resolveSchedule({ item, scheduledFor: b.start });
    const pricing = computePricing({ item, guestCount: b.guests, units: sched.units });
    const code = await generateBookingCode();

    const row = {
      bookingCode: code,
      userId: user.id,
      itemType: 'package',
      itemId: pkg.id,
      itemSnapshot: snapshot,
      scheduledFor: sched.scheduledFor,
      scheduledEndAt: sched.scheduledEndAt,
      units: sched.units,
      guestName: user.name,
      guestEmail: user.email,
      guestPhone: user.phone,
      guestCount: b.guests,
      currency: pricing.currency,
      unitPricePaise: pricing.unitPricePaise,
      subtotalPaise: pricing.subtotalPaise,
      gstPaise: pricing.gstPaise,
      tcsPaise: pricing.tcsPaise,
      taxPaise: pricing.taxPaise,
      totalPaise: pricing.totalPaise,
      status: b.status,
    };

    if (b.paidAt) {
      row.paymentOrderId = `order_${code}`;
      row.paymentId = `cf_pay_${Math.random().toString(36).slice(2, 12)}`;
      row.paymentMethod = b.method;
      row.paidAt = new Date(b.paidAt);
    }
    if (b.refund) {
      row.refundedAt = new Date('2026-01-25T08:00:00Z');
      row.refundAmountPaise = pricing.totalPaise;
      row.refundStatus = 'completed';
      row.cancelledAt = new Date('2026-01-24T08:00:00Z');
      row.cancellationReason = 'Plans changed';
      row.cancellationReasonCode = 'plan_change';
    }

    await Booking.create(row);
    n += 1;
  }
  console.log(`[SEED:test] ${n} bookings seeded (paid + refunded + pending)`);

  console.log('\n[SEED:test] DONE. Sign in as the member with email-OTP:');
  console.log(`            ${DEMO_EMAIL}`);
  process.exit(0);
};

run().catch((err) => {
  console.error('[SEED:test] Failed:', err);
  process.exit(1);
});

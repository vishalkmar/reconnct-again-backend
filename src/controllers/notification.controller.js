const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Booking, WalletTransaction, User, Experience,
} = require('../models');
const { ok } = require('../utils/response');

/*
  Notifications feed — the SINGLE source of truth for both the mobile app and
  the website, so the two always tally. There's no separate notifications table
  yet: the feed is derived server-side from the user's REAL activity (bookings +
  wallet transactions) plus a welcome note. Because both clients hit this one
  endpoint, they render identical lists. `kind` tells the client which icon to
  draw (clients never hardcode text/emoji).
*/

const fromPaise = (p) => Math.round(Number(p || 0)) / 100;

// GET /api/notifications — newest first.
const list = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [bookings, txns, user, myListings] = await Promise.all([
    Booking.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 50 }),
    WalletTransaction.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 50 }),
    User.findByPk(userId, { attributes: ['name', 'createdAt'] }),
    Experience.findAll({ where: { ownerUserId: userId }, attributes: ['id', 'name'] }),
  ]);

  const feed = [];
  // The in-app "starting soon" reminder — separate from the 6h-before EMAIL
  // wave (reminder.service.js) — fires within 1 hour of scheduledAt. This is
  // derived live off the real scheduledAt instant, not an active dispatch, so
  // it just shows/hides itself as the window opens.
  const now = Date.now();
  const REMINDER_WINDOW_HOURS = 1;
  const withinHours = (scheduledAt, hours) => {
    if (!scheduledAt) return false;
    const diffMs = new Date(scheduledAt).getTime() - now;
    return diffMs > 0 && diffMs <= hours * 60 * 60 * 1000;
  };

  // "Switch to Hosting" side: bookings made on any experience this user owns.
  // Same feed endpoint for both traveller and host notifications, so opening
  // the bell from either mode shows the relevant real activity.
  if (myListings.length) {
    const listingNames = new Map(myListings.map((e) => [e.id, e.name]));
    const hostBookings = await Booking.findAll({
      where: {
        itemType: 'experience',
        itemId: { [Op.in]: myListings.map((e) => e.id) },
        status: { [Op.in]: ['confirmed', 'completed'] },
      },
      order: [['createdAt', 'DESC']],
      limit: 50,
    });
    for (const b of hostBookings) {
      const j = b.toJSON();
      const listingName = listingNames.get(j.itemId) || 'Your experience';
      feed.push({
        id: `h${j.id}`,
        kind: 'host_booking',
        bookingId: j.id,
        title: 'New booking on your listing',
        body: `${listingName} — ${j.guestName || 'Guest'} · #${j.bookingCode}`,
        // Base amount — matches the voucher email; never the guest's full
        // total (that includes GST/convenience fee, not the host's money).
        amount: j.subtotalPaise ? fromPaise(j.subtotalPaise) : null,
        at: j.paidAt || j.createdAt,
      });
      if (j.status === 'confirmed' && withinHours(j.scheduledAt, REMINDER_WINDOW_HOURS)) {
        feed.push({
          id: `hr${j.id}`,
          kind: 'reminder',
          title: 'Booking in 1 hour',
          body: `${listingName} — ${j.guestName || 'Guest'} (${j.guestCount || 1} guest${j.guestCount === 1 ? '' : 's'})`,
          at: new Date().toISOString(),
        });
      }
    }
  }

  for (const b of bookings) {
    const j = b.toJSON();
    const snap = j.itemSnapshot || {};
    const title = snap.name || snap.title || 'your experience';
    const paid = ['confirmed', 'paid', 'completed'].includes(j.status);
    const cancelled = ['cancelled', 'refunded'].includes(j.status);
    feed.push({
      id: `b${j.id}`,
      kind: 'booking',
      status: j.status,
      title: cancelled ? 'Booking cancelled' : paid ? 'Booking confirmed' : 'Booking pending payment',
      body: `${title} — #${j.bookingCode}`,
      amount: j.totalPaise ? fromPaise(j.totalPaise) : null,
      at: j.createdAt || j.scheduledFor,
    });
    if (j.status === 'confirmed' && withinHours(j.scheduledAt, REMINDER_WINDOW_HOURS)) {
      feed.push({
        id: `r${j.id}`,
        kind: 'reminder',
        title: 'Starting in 1 hour',
        body: `${title} — don't forget!`,
        at: new Date().toISOString(),
      });
    }
  }

  for (const t of txns) {
    const j = t.toJSON();
    feed.push({
      id: `w${j.id}`,
      kind: 'wallet',
      title: 'Wallet update',
      body: j.description || j.type || 'Transaction',
      amount: j.amountPaise != null ? fromPaise(j.amountPaise) : null,
      at: j.createdAt,
    });
  }

  feed.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  const firstName = (user && user.name ? String(user.name).split(/\s+/)[0] : '') || '';
  feed.push({
    id: 'welcome',
    kind: 'welcome',
    title: `Welcome to reconnct${firstName ? `, ${firstName}` : ''}!`,
    body: 'Discover experiences near you and book in seconds.',
    at: user && user.createdAt ? user.createdAt : '',
  });

  return ok(res, { notifications: feed, count: feed.length });
});

module.exports = { list };

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  User, Booking, Experience,
} = require('../models');
const { ok } = require('../utils/response');

/*
  Admin notifications feed — same "derive from real activity, no separate
  table" approach as the traveller/host feed in notification.controller.js,
  but scoped globally (the admin sees everything) instead of per-user. One
  endpoint, several `kind`s: new signups, bookings, payments, and new host
  listings — so the admin topbar bell can show one combined, real feed.
*/

const fromPaise = (p) => Math.round(Number(p || 0)) / 100;

// GET /api/admin/notifications
const list = asyncHandler(async (req, res) => {
  const [users, bookings, listings] = await Promise.all([
    User.findAll({ order: [['createdAt', 'DESC']], limit: 30, attributes: ['id', 'name', 'email', 'createdAt'] }),
    Booking.findAll({ order: [['createdAt', 'DESC']], limit: 50 }),
    Experience.findAll({
      where: { ownerUserId: { [Op.ne]: null } },
      order: [['createdAt', 'DESC']],
      limit: 30,
      attributes: ['id', 'name', 'ownerUserId', 'createdAt'],
    }),
  ]);

  const feed = [];

  for (const u of users) {
    feed.push({
      id: `u${u.id}`,
      kind: 'user_registered',
      title: 'New user registered',
      body: `${u.name || u.email} joined reconnct`,
      at: u.createdAt,
    });
  }

  for (const b of bookings) {
    const j = b.toJSON();
    const snap = j.itemSnapshot || {};
    feed.push({
      id: `bk${j.id}`,
      kind: 'booking',
      title: 'New booking',
      body: `${j.guestName || 'Guest'} booked ${snap.name || 'an experience'} — #${j.bookingCode}`,
      amount: j.totalPaise ? fromPaise(j.totalPaise) : null,
      at: j.createdAt,
    });
    if (j.paidAt) {
      feed.push({
        id: `pay${j.id}`,
        kind: 'payment',
        title: 'Payment received',
        body: `${fromPaise(j.totalPaise)} from ${j.guestName || 'Guest'} — #${j.bookingCode}`,
        amount: fromPaise(j.totalPaise),
        at: j.paidAt,
      });
    }
  }

  const hostIds = [...new Set(listings.map((l) => l.ownerUserId))];
  const hosts = hostIds.length
    ? await User.findAll({ where: { id: hostIds }, attributes: ['id', 'name', 'email'] })
    : [];
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  for (const l of listings) {
    const host = hostById.get(l.ownerUserId);
    feed.push({
      id: `lst${l.id}`,
      kind: 'host_listing',
      title: 'New host listing',
      body: `${host ? (host.name || host.email) : 'A host'} listed "${l.name}"`,
      at: l.createdAt,
    });
  }

  feed.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return ok(res, { notifications: feed.slice(0, 100), count: feed.length });
});

module.exports = { list };

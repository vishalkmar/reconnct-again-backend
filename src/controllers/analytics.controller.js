const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { Booking } = require('../models');
const { ok } = require('../utils/response');

/*
  Revenue analytics — all derived from the `bookings` table.
   - Revenue counts PAID bookings (confirmed/completed), bucketed by paidAt
     (fallback createdAt).
   - "Abandoned" counts bookings where someone started but never paid
     (pending_payment, or cancelled with no payment), bucketed by createdAt.
   - Activity identity = `${itemType}:${itemId}`, label from itemSnapshot.name.
   - City = itemSnapshot.location (best available signal on a booking).
  Aggregation is done in-memory: simple, exact, and fine for these volumes.
*/

const PAID = ['confirmed', 'completed'];
const toR = (paise) => Number(paise || 0) / 100;

const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const mondayOf = (input) => {
  const x = new Date(input);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};

const bucketOf = (date, interval) => (interval === 'month' ? monthKey(new Date(date)) : dstr(mondayOf(date)));

const enumerateBuckets = (start, end, interval) => {
  const out = [];
  if (interval === 'month') {
    let y = start.getFullYear(); let m = start.getMonth();
    const ey = end.getFullYear(); const em = end.getMonth();
    while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad(m + 1)}`); m++; if (m > 11) { m = 0; y++; } }
  } else {
    let cur = mondayOf(start); const last = mondayOf(end);
    while (cur <= last) { out.push(dstr(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 7); }
  }
  return out;
};

const keyOf = (b) => `${b.itemType}:${b.itemId}`;
const nameOf = (b) => (b.itemSnapshot && b.itemSnapshot.name) || `${b.itemType} #${b.itemId}`;
const cityOf = (b) => (b.itemSnapshot && b.itemSnapshot.location) || null;
const revDate = (b) => b.paidAt || b.createdAt;
const isAbandoned = (b) => b.status === 'pending_payment' || (b.status === 'cancelled' && !b.paidAt);

const summarize = (bookings, start, end) => {
  let revenue = 0; let count = 0; let participants = 0; let tax = 0;
  for (const b of bookings) {
    if (!PAID.includes(b.status)) continue;
    const d = new Date(revDate(b));
    if (d < start || d > end) continue;
    revenue += toR(b.totalPaise);
    tax += toR(b.taxPaise);
    count += 1;
    participants += Number(b.guestCount || 1);
  }
  return {
    totalRevenue: Math.round(revenue * 100) / 100,
    bookingCount: count,
    avgPerBooking: count ? Math.round((revenue / count) * 100) / 100 : 0,
    grossMargin: Math.round((revenue - tax) * 100) / 100, // revenue net of GST/TCS pass-through
    avgParticipants: count ? Math.round((participants / count) * 100) / 100 : 0,
  };
};

const pctDelta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 10000) / 100 : null);

// GET /api/admin/analytics/revenue
const revenue = asyncHandler(async (req, res) => {
  const now = new Date();
  const end = req.query.end ? new Date(`${req.query.end}T23:59:59`) : now;
  const start = req.query.start ? new Date(`${req.query.start}T00:00:00`)
    : new Date(new Date(end).setMonth(end.getMonth() - 3));

  const spanDays = (end - start) / (1000 * 60 * 60 * 24);
  const interval = req.query.interval === 'month' || req.query.interval === 'week'
    ? req.query.interval
    : (spanDays > 120 ? 'month' : 'week');

  // Previous equal-length window (for the comparison %).
  const len = end - start;
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - len);

  // One fetch covering both windows.
  const all = await Booking.findAll({
    where: {
      [Op.or]: [
        { createdAt: { [Op.between]: [prevStart, end] } },
        { paidAt: { [Op.between]: [prevStart, end] } },
      ],
    },
    attributes: ['id', 'itemType', 'itemId', 'itemSnapshot', 'status', 'totalPaise', 'taxPaise', 'guestCount', 'paidAt', 'createdAt'],
    order: [['createdAt', 'ASC']],
    raw: true,
  });

  // Dropdown universes — computed over the current window BEFORE city/activity
  // filtering so the selectors always offer every available option.
  const inWindow = (b) => {
    const rd = new Date(revDate(b));
    const cd = new Date(b.createdAt);
    return (rd >= start && rd <= end) || (cd >= start && cd <= end);
  };
  const windowBookings = all.filter(inWindow);

  const cityCount = new Map();
  const actMap = new Map();
  for (const b of windowBookings) {
    const c = cityOf(b);
    if (c) cityCount.set(c, (cityCount.get(c) || 0) + 1);
    const k = keyOf(b);
    if (!actMap.has(k)) actMap.set(k, { key: k, name: nameOf(b), itemType: b.itemType, itemId: b.itemId });
  }
  const cities = [...cityCount.keys()].sort();
  const activities = [...actMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Apply optional filters.
  const cityF = req.query.city || null;
  const actF = req.query.activityKey || null;
  const match = (b) => (!cityF || cityOf(b) === cityF) && (!actF || keyOf(b) === actF);
  const filtered = all.filter(match);

  // Series (current window).
  const buckets = enumerateBuckets(start, end, interval);
  const rev = new Map(buckets.map((bk) => [bk, { total: 0, items: new Map() }]));
  const aban = new Map(buckets.map((bk) => [bk, { total: 0, items: new Map() }]));
  const activityRevenue = new Map();

  for (const b of filtered) {
    if (PAID.includes(b.status)) {
      const d = new Date(revDate(b));
      if (d >= start && d <= end) {
        const slot = rev.get(bucketOf(d, interval));
        if (slot) {
          const r = toR(b.totalPaise);
          const k = keyOf(b);
          slot.total += r;
          slot.items.set(k, (slot.items.get(k) || 0) + r);
          activityRevenue.set(k, (activityRevenue.get(k) || 0) + r);
        }
      }
    }
    if (isAbandoned(b)) {
      const d = new Date(b.createdAt);
      if (d >= start && d <= end) {
        const slot = aban.get(bucketOf(d, interval));
        if (slot) { slot.total += 1; const k = keyOf(b); slot.items.set(k, (slot.items.get(k) || 0) + 1); }
      }
    }
  }

  // Activities ranked by revenue (drives colour priority = "hot selling").
  const ranked = [...activityRevenue.entries()]
    .map(([key, r]) => ({ key, name: actMap.get(key)?.name || key, revenue: Math.round(r) }))
    .sort((a, b) => b.revenue - a.revenue);

  const series = buckets.map((bk) => ({
    bucket: bk,
    total: Math.round(rev.get(bk).total),
    items: [...rev.get(bk).items.entries()].map(([key, r]) => ({ key, revenue: Math.round(r) })).sort((a, b) => b.revenue - a.revenue),
  }));
  const abandoned = buckets.map((bk) => ({
    bucket: bk,
    total: aban.get(bk).total,
    items: [...aban.get(bk).items.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
  }));

  const cur = summarize(filtered, start, end);
  const prev = summarize(filtered, prevStart, prevEnd);

  return ok(res, {
    range: { start: dstr(start), end: dstr(end), interval },
    summary: {
      ...cur,
      prev,
      delta: {
        totalRevenue: pctDelta(cur.totalRevenue, prev.totalRevenue),
        avgPerBooking: pctDelta(cur.avgPerBooking, prev.avgPerBooking),
        grossMargin: pctDelta(cur.grossMargin, prev.grossMargin),
        avgParticipants: pctDelta(cur.avgParticipants, prev.avgParticipants),
      },
    },
    series,
    abandoned,
    ranked,            // [{key,name,revenue}] sorted desc
    activities,        // [{key,name,...}] for the dropdown
    cities,            // [name] for the dropdown
  });
});

module.exports = { revenue };

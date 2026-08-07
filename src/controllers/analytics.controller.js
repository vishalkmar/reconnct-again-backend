const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Booking, Experience, Supplier, ExperienceCategory, ExperienceType,
} = require('../models');
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

/* ═══════════════════════════════════════════════════════════════════════
   Deep-dive Revenue Analysis  —  GET /api/admin/analytics/revenue-analysis
   A separate "why did it happen?" surface (the /revenue page stays the
   overview). Everything is derived from real bookings + the experiences /
   suppliers they point at. Profit here = B2C − B2B (totalPaise − subtotalPaise),
   the platform's actual margin. Nothing is fabricated: metrics that the schema
   cannot support (page views, booking source) are simply omitted.
   ══════════════════════════════════════════════════════════════════════ */
const dayKeyOf = (d) => dstr(new Date(d));
const bucketKey = (d, interval) => {
  if (interval === 'day') return dayKeyOf(d);
  if (interval === 'month') return monthKey(new Date(d));
  return dstr(mondayOf(d));
};
const enumerate = (start, end, interval) => {
  if (interval === 'day') {
    const out = []; const cur = new Date(start); cur.setHours(0, 0, 0, 0);
    while (cur <= end) { out.push(dstr(cur)); cur.setDate(cur.getDate() + 1); }
    return out;
  }
  return enumerateBuckets(start, end, interval);
};
const r0 = (n) => Math.round(Number(n) || 0);
const pct1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const marginPct = (rev, profit) => (rev > 0 ? pct1((profit / rev) * 100) : 0);

// Payment state derived from the lifecycle (there is no paymentStatus column).
const payState = (b) => {
  if (b.status === 'refunded' || Number(b.refundAmountPaise) > 0) return 'refunded';
  if (PAID.includes(b.status)) return 'paid';
  if (b.status === 'cancelled') return 'cancelled';
  if (b.paymentFailedAt || (b.lastPaymentStatus && /fail|expire|terminat|cancel/i.test(b.lastPaymentStatus))) return 'failed';
  return 'pending';
};

const revenueAnalysis = asyncHandler(async (req, res) => {
  const now = new Date();
  const end = req.query.end ? new Date(`${req.query.end}T23:59:59`) : now;
  const start = req.query.start ? new Date(`${req.query.start}T00:00:00`)
    : new Date(new Date(end).setMonth(end.getMonth() - 3));
  const spanDays = (end - start) / 86400000;
  const interval = ['day', 'week', 'month'].includes(req.query.interval)
    ? req.query.interval
    : (spanDays <= 31 ? 'day' : spanDays <= 120 ? 'week' : 'month');

  // Previous equal window (growth / comparison).
  const len = end - start;
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - len);

  // One fetch across both windows — experiences only (this analysis is scoped
  // to experiences, matching what the app sells & the B2B pricing model).
  const all = await Booking.findAll({
    where: {
      itemType: 'experience',
      [Op.or]: [
        { createdAt: { [Op.between]: [prevStart, end] } },
        { paidAt: { [Op.between]: [prevStart, end] } },
      ],
    },
    attributes: ['id', 'bookingCode', 'itemId', 'itemSnapshot', 'userId', 'guestName', 'guestEmail', 'guestCount',
      'status', 'subtotalPaise', 'totalPaise', 'taxPaise', 'refundAmountPaise', 'paymentMethod', 'paymentOrderId',
      'paymentFailedAt', 'lastPaymentStatus', 'cancellationReasonCode', 'scheduledFor', 'paidAt', 'createdAt'],
    order: [['createdAt', 'ASC']],
    raw: true,
  });

  // Resolve the experiences these bookings point at → city / category / supplier.
  const expIds = [...new Set(all.map((b) => b.itemId))];
  const exps = expIds.length ? await Experience.findAll({
    where: { id: { [Op.in]: expIds } },
    attributes: ['id', 'name', 'city', 'location', 'supplierId'],
    include: [
      { model: ExperienceCategory, as: 'category', attributes: ['name'] },
      { model: ExperienceType, as: 'type', attributes: ['name'] },
      { model: Supplier, as: 'supplier', attributes: ['id', 'companyName'] },
    ],
  }) : [];
  const expMap = new Map(exps.map((e) => {
    const j = e.toJSON();
    return [j.id, {
      name: j.name,
      city: j.city || j.location || null,
      category: (j.category && j.category.name) || null,
      type: (j.type && j.type.name) || null,
      supplierId: j.supplierId || null,
      supplier: (j.supplier && j.supplier.companyName) || null,
    }];
  }));
  const meta = (b) => expMap.get(b.itemId) || {};
  const cityOfB = (b) => meta(b).city || cityOf(b) || '—';
  const catOfB = (b) => meta(b).category || 'Uncategorised';
  const nameOfB = (b) => meta(b).name || nameOf(b);
  const supOfB = (b) => ({ id: meta(b).supplierId, name: meta(b).supplier || (meta(b).supplierId ? `Supplier #${meta(b).supplierId}` : 'Host / direct') });

  // Filter universes (before entity filters so dropdowns stay complete).
  const inCur = (b) => { const rd = new Date(revDate(b)); const cd = new Date(b.createdAt); return (rd >= start && rd <= end) || (cd >= start && cd <= end); };
  const curAll = all.filter(inCur);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  const universes = {
    cities: uniq(curAll.map(cityOfB)),
    categories: uniq(curAll.map(catOfB)),
    experiences: [...new Map(curAll.map((b) => [b.itemId, { id: b.itemId, name: nameOfB(b) }])).values()].sort((a, b) => a.name.localeCompare(b.name)),
    suppliers: [...new Map(curAll.filter((b) => meta(b).supplierId).map((b) => [meta(b).supplierId, { id: meta(b).supplierId, name: supOfB(b).name }])).values()].sort((a, b) => a.name.localeCompare(b.name)),
  };

  // Entity filters (scope the whole page).
  const { city, category, experienceId, supplierId, bookingStatus, paymentStatus } = req.query;
  const scopeMatch = (b) => (!city || cityOfB(b) === city)
    && (!category || catOfB(b) === category)
    && (!experienceId || String(b.itemId) === String(experienceId))
    && (!supplierId || String(meta(b).supplierId) === String(supplierId));
  const scoped = all.filter(scopeMatch);

  // Status filters narrow the KPI/table view (funnel/abandoned/payments below
  // deliberately keep the full scoped set since they analyse across statuses).
  const statusMatch = (b) => (!bookingStatus || b.status === bookingStatus)
    && (!paymentStatus || payState(b) === paymentStatus);

  const inWin = (b, s, e) => { const d = new Date(revDate(b)); return d >= s && d <= e; };
  const inWinCreated = (b, s, e) => { const d = new Date(b.createdAt); return d >= s && d <= e; };

  // ── KPIs ────────────────────────────────────────────────────────────────
  const kpiOf = (s, e) => {
    let revenue = 0; let cost = 0; let bookings = 0; let refunded = 0; let pending = 0; let guests = 0;
    for (const b of scoped) {
      if (!statusMatch(b)) continue;
      if (PAID.includes(b.status) && inWin(b, s, e)) {
        revenue += toR(b.totalPaise); cost += toR(b.subtotalPaise); bookings += 1; guests += Number(b.guestCount || 1);
      }
      if (Number(b.refundAmountPaise) > 0 && inWinCreated(b, s, e)) refunded += toR(b.refundAmountPaise);
      if (b.status === 'pending_payment' && inWinCreated(b, s, e)) pending += toR(b.totalPaise);
    }
    const profit = revenue - cost;
    return {
      totalRevenue: r0(revenue),
      netRevenue: r0(revenue - refunded),
      grossProfit: r0(profit),
      grossMarginPct: marginPct(revenue, profit),
      avgBookingValue: bookings ? r0(revenue / bookings) : 0,
      totalBookings: bookings,
      refundedAmount: r0(refunded),
      pendingRevenue: r0(pending),
      platformCommission: r0(profit), // margin the go-live extras created
      avgGuests: bookings ? pct1(guests / bookings) : 0,
    };
  };
  const kpis = kpiOf(start, end);
  const prevKpis = kpiOf(prevStart, prevEnd);
  const deltas = {};
  Object.keys(kpis).forEach((k) => { deltas[k] = pctDelta(kpis[k], prevKpis[k]); });

  // ── Revenue trend (revenue / profit / previous-period revenue) ───────────
  const buckets = enumerate(start, end, interval);
  const prevBuckets = enumerate(prevStart, prevEnd, interval);
  const trendMap = new Map(buckets.map((bk) => [bk, { revenue: 0, profit: 0 }]));
  for (const b of scoped) {
    if (!statusMatch(b) || !PAID.includes(b.status) || !inWin(b, start, end)) continue;
    const slot = trendMap.get(bucketKey(revDate(b), interval));
    if (slot) { slot.revenue += toR(b.totalPaise); slot.profit += toR(b.totalPaise - b.subtotalPaise); }
  }
  const prevSeries = new Map(prevBuckets.map((bk) => [bk, 0]));
  for (const b of scoped) {
    if (!PAID.includes(b.status) || !inWin(b, prevStart, prevEnd)) continue;
    const k = bucketKey(revDate(b), interval);
    if (prevSeries.has(k)) prevSeries.set(k, prevSeries.get(k) + toR(b.totalPaise));
  }
  const prevVals = [...prevSeries.values()];
  const trend = buckets.map((bk, i) => ({
    bucket: bk,
    revenue: r0(trendMap.get(bk).revenue),
    profit: r0(trendMap.get(bk).profit),
    prevRevenue: r0(prevVals[i] || 0),
  }));

  // ── Per-experience rollup (drives top / low / margin) ────────────────────
  const perExp = new Map();
  const bump = (map, key, seed) => { if (!map.has(key)) map.set(key, seed()); return map.get(key); };
  for (const b of scoped) {
    const e = bump(perExp, b.itemId, () => ({
      id: b.itemId, name: nameOfB(b), city: cityOfB(b), category: catOfB(b), supplier: supOfB(b).name,
      revenue: 0, cost: 0, bookings: 0, guests: 0, cancelled: 0, total: 0, prevRevenue: 0, lastPaidAt: null,
    }));
    const paidCur = PAID.includes(b.status) && inWin(b, start, end);
    const paidPrev = PAID.includes(b.status) && inWin(b, prevStart, prevEnd);
    if (inWinCreated(b, start, end)) { e.total += 1; if (b.status === 'cancelled') e.cancelled += 1; }
    if (paidCur) {
      e.revenue += toR(b.totalPaise); e.cost += toR(b.subtotalPaise); e.bookings += 1; e.guests += Number(b.guestCount || 1);
      const pd = b.paidAt || b.createdAt; if (!e.lastPaidAt || new Date(pd) > new Date(e.lastPaidAt)) e.lastPaidAt = pd;
    }
    if (paidPrev) e.prevRevenue += toR(b.totalPaise);
  }
  const expRows = [...perExp.values()].map((e) => {
    const profit = e.revenue - e.cost;
    const daysAgo = e.lastPaidAt ? Math.floor((now - new Date(e.lastPaidAt)) / 86400000) : null;
    return {
      ...e,
      revenue: r0(e.revenue), cost: r0(e.cost), profit: r0(profit),
      avg: e.bookings ? r0(e.revenue / e.bookings) : 0,
      marginPct: marginPct(e.revenue, profit),
      growthPct: pctDelta(e.revenue, e.prevRevenue),
      cancelRate: e.total ? pct1((e.cancelled / e.total) * 100) : 0,
      daysSinceBooking: daysAgo,
    };
  });
  const topExperiences = [...expRows].filter((e) => e.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const marginAnalysis = [...expRows].filter((e) => e.revenue > 0).sort((a, b) => b.profit - a.profit).slice(0, 25);
  // Needs attention — real signals only: negative growth, high cancellation,
  // thin margin, or stale (no booking in 30d despite prior activity).
  const lowExperiences = [...expRows].map((e) => {
    const flags = [];
    if (e.growthPct != null && e.growthPct < -15) flags.push(`Revenue down ${Math.abs(e.growthPct)}%`);
    if (e.cancelRate >= 20 && e.total >= 3) flags.push(`High cancellation ${e.cancelRate}%`);
    if (e.marginPct < 10 && e.revenue > 0) flags.push(`Thin margin ${e.marginPct}%`);
    if (e.daysSinceBooking != null && e.daysSinceBooking > 30) flags.push(`No booking in ${e.daysSinceBooking}d`);
    return { ...e, flags };
  }).filter((e) => e.flags.length).sort((a, b) => b.flags.length - a.flags.length || b.revenue - a.revenue).slice(0, 10);

  // ── Suppliers ────────────────────────────────────────────────────────────
  const perSup = new Map();
  for (const b of scoped) {
    const s = supOfB(b); const key = s.id || `x-${s.name}`;
    const row = bump(perSup, key, () => ({ id: s.id, name: s.name, experiences: new Set(), revenue: 0, cost: 0, bookings: 0, cancelled: 0, total: 0 }));
    row.experiences.add(b.itemId);
    if (inWinCreated(b, start, end)) { row.total += 1; if (b.status === 'cancelled') row.cancelled += 1; }
    if (PAID.includes(b.status) && inWin(b, start, end)) { row.revenue += toR(b.totalPaise); row.cost += toR(b.subtotalPaise); row.bookings += 1; }
  }
  const suppliers = [...perSup.values()].map((s) => {
    const profit = s.revenue - s.cost;
    return {
      id: s.id, name: s.name, experiences: s.experiences.size, bookings: s.bookings,
      revenue: r0(s.revenue), cost: r0(s.cost), margin: r0(profit), marginPct: marginPct(s.revenue, profit),
      cancelRate: s.total ? pct1((s.cancelled / s.total) * 100) : 0,
    };
  }).filter((s) => s.bookings > 0 || s.revenue > 0).sort((a, b) => b.revenue - a.revenue);

  // ── City & Category ──────────────────────────────────────────────────────
  const group = (labelOf) => {
    const m = new Map();
    for (const b of scoped) {
      const label = labelOf(b);
      const row = bump(m, label, () => ({ label, revenue: 0, cost: 0, bookings: 0, prevRevenue: 0 }));
      if (PAID.includes(b.status) && inWin(b, start, end)) { row.revenue += toR(b.totalPaise); row.cost += toR(b.subtotalPaise); row.bookings += 1; }
      if (PAID.includes(b.status) && inWin(b, prevStart, prevEnd)) row.prevRevenue += toR(b.totalPaise);
    }
    return [...m.values()].map((x) => ({
      label: x.label, revenue: r0(x.revenue), bookings: x.bookings,
      profit: r0(x.revenue - x.cost), marginPct: marginPct(x.revenue, x.revenue - x.cost),
      avg: x.bookings ? r0(x.revenue / x.bookings) : 0, growthPct: pctDelta(x.revenue, x.prevRevenue),
    })).filter((x) => x.revenue > 0 || x.bookings > 0).sort((a, b) => b.revenue - a.revenue);
  };
  const cities = group(cityOfB);
  const categories = group(catOfB);

  // ── Customers (new vs repeat, top) — window-scoped ordering ──────────────
  const byUser = new Map();
  for (const b of scoped) {
    if (!PAID.includes(b.status) || !inWin(b, start, end)) continue;
    const arr = byUser.get(b.userId) || []; arr.push(b); byUser.set(b.userId, arr);
  }
  let newRev = 0; let repeatRev = 0; let newCust = 0; let repeatCust = 0;
  const custRows = [];
  for (const [uid, list] of byUser) {
    list.sort((a, b) => new Date(revDate(a)) - new Date(revDate(b)));
    const rev = list.reduce((s, b) => s + toR(b.totalPaise), 0);
    const isRepeat = list.length > 1;
    if (isRepeat) { repeatCust += 1; repeatRev += rev - toR(list[0].totalPaise); newRev += toR(list[0].totalPaise); }
    else { newCust += 1; newRev += rev; }
    custRows.push({ userId: uid, name: list[list.length - 1].guestName, email: list[list.length - 1].guestEmail, revenue: r0(rev), bookings: list.length });
  }
  const totalCust = newCust + repeatCust;
  const customers = {
    newRevenue: r0(newRev), repeatRevenue: r0(repeatRev),
    newCustomers: newCust, repeatCustomers: repeatCust,
    repeatPct: totalCust ? pct1((repeatCust / totalCust) * 100) : 0,
    revenuePerCustomer: totalCust ? r0((newRev + repeatRev) / totalCust) : 0,
    top: custRows.sort((a, b) => b.revenue - a.revenue).slice(0, 8),
  };

  // ── Booking funnel + leakage (real lifecycle, not page views) ────────────
  const winCreated = scoped.filter((b) => inWinCreated(b, start, end));
  const started = winCreated.length;
  const paymentAttempted = winCreated.filter((b) => b.paymentOrderId || b.paymentFailedAt || PAID.includes(b.status)).length;
  const confirmed = winCreated.filter((b) => PAID.includes(b.status)).length;
  const lostList = winCreated.filter((b) => !PAID.includes(b.status) && b.status !== 'cancelled');
  const funnel = {
    started,
    paymentAttempted,
    confirmed,
    conversionPct: started ? pct1((confirmed / started) * 100) : 0,
    lostBookings: lostList.length,
    lostRevenue: r0(lostList.reduce((s, b) => s + toR(b.totalPaise), 0)),
  };

  // ── Abandoned analysis (reasons from real fields) ────────────────────────
  const abandonedList = winCreated.filter((b) => b.status === 'pending_payment');
  const reasons = { failed: 0, left: 0, retrying: 0 };
  abandonedList.forEach((b) => {
    if (b.paymentFailedAt || (b.lastPaymentStatus && /fail|expire|terminat/i.test(b.lastPaymentStatus))) reasons.failed += 1;
    else if (b.paymentOrderId) reasons.retrying += 1;
    else reasons.left += 1;
  });
  const abTotal = abandonedList.length || 1;
  const abPot = abandonedList.reduce((s, b) => s + toR(b.totalPaise), 0);
  const abandoned = {
    count: abandonedList.length,
    potentialRevenue: r0(abPot),
    avgLost: abandonedList.length ? r0(abPot / abandonedList.length) : 0,
    reasons: [
      { label: 'Payment failed / expired', count: reasons.failed, pct: pct1((reasons.failed / abTotal) * 100) },
      { label: 'Left before paying', count: reasons.left, pct: pct1((reasons.left / abTotal) * 100) },
      { label: 'Started, still retrying', count: reasons.retrying, pct: pct1((reasons.retrying / abTotal) * 100) },
    ].filter((r) => r.count > 0),
  };

  // ── Payments ─────────────────────────────────────────────────────────────
  const pay = { paid: 0, failed: 0, pending: 0, refunded: 0 };
  const payAmt = { paid: 0, refunded: 0, pending: 0 };
  const methodMap = new Map();
  for (const b of winCreated) {
    const st = payState(b);
    if (pay[st] != null) pay[st] += 1;
    if (st === 'paid') { payAmt.paid += toR(b.totalPaise); const m = b.paymentMethod || 'Unknown'; methodMap.set(m, (methodMap.get(m) || 0) + toR(b.totalPaise)); }
    if (st === 'pending') payAmt.pending += toR(b.totalPaise);
    if (Number(b.refundAmountPaise) > 0) payAmt.refunded += toR(b.refundAmountPaise);
  }
  const payTotalAttempts = pay.paid + pay.failed;
  const payments = {
    successful: { count: pay.paid, amount: r0(payAmt.paid) },
    failed: { count: pay.failed },
    pending: { count: pay.pending, amount: r0(payAmt.pending) },
    refunds: { count: winCreated.filter((b) => Number(b.refundAmountPaise) > 0).length, amount: r0(payAmt.refunded) },
    failureRatePct: payTotalAttempts ? pct1((pay.failed / payTotalAttempts) * 100) : 0,
    refundRatePct: pay.paid ? pct1((payments0RefundCount(winCreated) / pay.paid) * 100) : 0,
    methods: [...methodMap.entries()].map(([method, amount]) => ({ method, amount: r0(amount) })).sort((a, b) => b.amount - a.amount),
  };

  // ── Cancellation & refund impact ─────────────────────────────────────────
  const cancelledList = winCreated.filter((b) => b.status === 'cancelled' || b.status === 'refunded');
  const cancelReasons = new Map();
  const cancelByExp = new Map();
  cancelledList.forEach((b) => {
    const code = b.cancellationReasonCode || 'other';
    cancelReasons.set(code, (cancelReasons.get(code) || 0) + 1);
    const nm = nameOfB(b); cancelByExp.set(nm, (cancelByExp.get(nm) || 0) + 1);
  });
  const cancellation = {
    cancelledCount: cancelledList.length,
    revenueLost: r0(cancelledList.reduce((s, b) => s + toR(b.totalPaise), 0)),
    refunded: r0(cancelledList.reduce((s, b) => s + toR(b.refundAmountPaise), 0)),
    cancellationRatePct: started ? pct1((cancelledList.length / started) * 100) : 0,
    reasons: [...cancelReasons.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    topExperiences: [...cancelByExp.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5),
  };

  // ── Forecast (simple velocity projection — no AI) ────────────────────────
  const elapsed = Math.max(1, (Math.min(now, end) - start) / 86400000);
  const dailyRate = kpis.totalRevenue / elapsed;
  const forecast = { next30: r0(dailyRate * 30), dailyRate: r0(dailyRate), basis: 'Booking velocity over the selected period' };

  // ── Auto insights ────────────────────────────────────────────────────────
  const insights = [];
  if (deltas.totalRevenue != null) insights.push(`Revenue ${deltas.totalRevenue >= 0 ? 'up' : 'down'} ${Math.abs(deltas.totalRevenue)}% vs the previous period.`);
  if (categories[0] && kpis.totalRevenue) insights.push(`${categories[0].label} led with ${pct1((categories[0].revenue / kpis.totalRevenue) * 100)}% of revenue.`);
  if (cities[0] && kpis.totalRevenue) insights.push(`${cities[0].label} generated the most revenue (₹${cities[0].revenue.toLocaleString('en-IN')}).`);
  const thin = expRows.filter((e) => e.revenue > 0 && e.marginPct < 10).length;
  if (thin) insights.push(`${thin} experience${thin > 1 ? 's have' : ' has'} a margin below 10%.`);
  if (abandoned.potentialRevenue > 0) insights.push(`₹${abandoned.potentialRevenue.toLocaleString('en-IN')} of potential revenue is sitting in ${abandoned.count} abandoned bookings.`);
  if (payments.failureRatePct > 0) insights.push(`Payment failure rate is ${payments.failureRatePct}%.`);

  // ── Detailed table (paid bookings, for the grid + export) ────────────────
  const table = scoped
    .filter((b) => statusMatch(b) && PAID.includes(b.status) && inWin(b, start, end))
    .sort((a, b) => new Date(revDate(b)) - new Date(revDate(a)))
    .map((b) => ({
      code: b.bookingCode,
      date: dstr(new Date(revDate(b))),
      experience: nameOfB(b),
      supplier: supOfB(b).name,
      city: cityOfB(b),
      category: catOfB(b),
      guest: b.guestName,
      guests: b.guestCount,
      status: b.status,
      b2b: r0(toR(b.subtotalPaise)),
      b2c: r0(toR(b.totalPaise)),
      profit: r0(toR(b.totalPaise - b.subtotalPaise)),
    }));

  // ── Participants split (solo / couple / group) — real, from guestCount ───
  const paidWin = scoped.filter((b) => statusMatch(b) && PAID.includes(b.status) && inWin(b, start, end));
  let pTotal = 0; let solo = 0; let couple = 0; let grp = 0;
  paidWin.forEach((b) => { const g = Number(b.guestCount || 1); pTotal += g; if (g <= 1) solo += 1; else if (g === 2) couple += 1; else grp += 1; });
  const pc = paidWin.length || 1;
  const participants = {
    total: pTotal, avg: pct1(pTotal / pc), solo, couple, group: grp,
    soloPct: pct1((solo / pc) * 100), couplePct: pct1((couple / pc) * 100), groupPct: pct1((grp / pc) * 100),
  };

  // ── Booking status counts (created in window) ────────────────────────────
  const statusCounts = { confirmed: 0, completed: 0, cancelled: 0, refunded: 0, pending: 0 };
  winCreated.forEach((b) => { if (b.status === 'pending_payment') statusCounts.pending += 1; else if (statusCounts[b.status] != null) statusCounts[b.status] += 1; });

  // ── Peak performance (best weekday / best single date) ───────────────────
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const wdRev = new Map(); const dRev = new Map();
  paidWin.forEach((b) => {
    const dt = new Date(revDate(b));
    wdRev.set(dt.getDay(), (wdRev.get(dt.getDay()) || 0) + toR(b.totalPaise));
    const dk = dstr(dt); dRev.set(dk, (dRev.get(dk) || 0) + toR(b.totalPaise));
  });
  const bestWd = [...wdRev.entries()].sort((a, b) => b[1] - a[1])[0];
  const bestD = [...dRev.entries()].sort((a, b) => b[1] - a[1])[0];
  const peak = {
    bestDay: bestWd ? { label: WD[bestWd[0]], revenue: r0(bestWd[1]) } : null,
    bestDate: bestD ? { date: bestD[0], revenue: r0(bestD[1]) } : null,
  };

  return ok(res, {
    range: { start: dstr(start), end: dstr(end), interval },
    filters: universes,
    kpis: { ...kpis, prev: prevKpis, delta: deltas },
    participants,
    statusCounts,
    peak,
    trend,
    topExperiences,
    lowExperiences,
    marginAnalysis,
    suppliers,
    cities,
    categories,
    customers,
    funnel,
    abandoned,
    payments,
    cancellation,
    forecast,
    insights,
    table,
  });
});

// Refund count helper (kept out of the hot loop for clarity).
function payments0RefundCount(list) { return list.filter((b) => Number(b.refundAmountPaise) > 0).length; }

module.exports = { revenue, revenueAnalysis };

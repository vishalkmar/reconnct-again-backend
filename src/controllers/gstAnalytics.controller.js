const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Booking, Experience, ExperienceCategory, ExperienceAudience, Supplier,
} = require('../models');
const { ok } = require('../utils/response');

/*
  GST analytics — "how much GST did we actually collect, and on what?"

  Unlike markup (which had to be reconstructed), GST is stored per booking as
  `gstPaise`, so every number here is the real collected amount, not an estimate.

  Sliced by activity / broad category / who-is-this-for / city / supplier / rate
  slab / GST mode, over any date range. Paid bookings only (confirmed +
  completed), bucketed by the day the money landed (paidAt → createdAt).
*/

const PAID = ['confirmed', 'completed'];
const toR = (paise) => Number(paise || 0) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const mondayOf = (input) => {
  const x = new Date(input);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};
const bucketOf = (date, interval) => {
  if (interval === 'month') return monthKey(new Date(date));
  if (interval === 'day') return dstr(new Date(date));
  return dstr(mondayOf(date));
};
const enumerateBuckets = (start, end, interval) => {
  const out = [];
  if (interval === 'month') {
    let y = start.getFullYear(); let m = start.getMonth();
    const ey = end.getFullYear(); const em = end.getMonth();
    while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad(m + 1)}`); m += 1; if (m > 11) { m = 0; y += 1; } }
  } else if (interval === 'day') {
    let cur = new Date(start); cur.setHours(0, 0, 0, 0);
    while (cur <= end) { out.push(dstr(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 1); }
  } else {
    let cur = mondayOf(start); const last = mondayOf(end);
    while (cur <= last) { out.push(dstr(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 7); }
  }
  return out;
};

const revDate = (b) => b.paidAt || b.createdAt;

const MODE_LABEL = {
  global: 'Our GST (standard)',
  included: 'Already included by supplier',
  double: 'Supplier GST + ours (double)',
  pure: 'Supplier GST stripped (pure)',
};

const addTo = (map, key, label, patch) => {
  if (key == null) return;
  const cur = map.get(key) || { key, name: label, gst: 0, taxable: 0, revenue: 0, bookings: 0, guests: 0 };
  cur.gst += patch.gst;
  cur.taxable += patch.taxable;
  cur.revenue += patch.revenue;
  cur.bookings += 1;
  cur.guests += patch.guests;
  map.set(key, cur);
};

const listOf = (map) => [...map.values()]
  .map((v) => ({ ...v, gst: r2(v.gst), taxable: r2(v.taxable), revenue: r2(v.revenue) }))
  .sort((a, b) => b.gst - a.gst);

// GET /api/admin/pricing-setup/gst/analytics
const gstAnalytics = asyncHandler(async (req, res) => {
  const now = new Date();
  const end = req.query.end ? new Date(`${req.query.end}T23:59:59`) : now;
  const start = req.query.start ? new Date(`${req.query.start}T00:00:00`)
    : new Date(new Date(end).setMonth(end.getMonth() - 3));

  const spanDays = (end - start) / (1000 * 60 * 60 * 24);
  const interval = ['day', 'week', 'month'].includes(req.query.interval)
    ? req.query.interval
    : (spanDays > 120 ? 'month' : (spanDays <= 31 ? 'day' : 'week'));

  const len = end - start;
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - len);

  const bookings = await Booking.findAll({
    where: {
      itemType: 'experience',
      status: { [Op.in]: PAID },
      [Op.or]: [
        { paidAt: { [Op.between]: [prevStart, end] } },
        { createdAt: { [Op.between]: [prevStart, end] } },
      ],
    },
    attributes: ['id', 'bookingCode', 'itemId', 'itemSnapshot', 'status', 'guestName', 'guestCount',
      'subtotalPaise', 'gstPaise', 'taxPaise', 'totalPaise', 'paidAt', 'createdAt', 'scheduledFor'],
    order: [['createdAt', 'ASC']],
  });

  const expIds = [...new Set(bookings.map((b) => b.itemId))];
  const exps = expIds.length
    ? await Experience.findAll({
      where: { id: { [Op.in]: expIds } },
      attributes: ['id', 'name', 'city', 'location', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'gstRate', 'gstConfig', 'supplierId'],
    })
    : [];
  const expById = new Map(exps.map((e) => [e.id, e]));

  const [cats, auds, sups] = await Promise.all([
    ExperienceCategory.findAll({ attributes: ['id', 'name'] }),
    ExperienceAudience.findAll({ attributes: ['id', 'name'] }),
    Supplier.findAll({ attributes: ['id', 'companyName'] }),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const audName = new Map(auds.map((a) => [a.id, a.name]));
  const supName = new Map(sups.map((s) => [s.id, s.companyName]));

  const fCategory = req.query.categoryId ? Number(req.query.categoryId) : null;
  const fAudience = req.query.audienceId ? Number(req.query.audienceId) : null;
  const fExperience = req.query.experienceId ? Number(req.query.experienceId) : null;
  const fSupplier = req.query.supplierId ? Number(req.query.supplierId) : null;
  const fCity = req.query.city ? String(req.query.city) : null;
  const fRate = req.query.rate ? Number(req.query.rate) : null;
  const fMode = ['global', 'included', 'double', 'pure'].includes(req.query.mode) ? req.query.mode : null;

  const catsOf = (exp) => {
    const list = Array.isArray(exp?.categoryIds) ? exp.categoryIds.map(Number) : [];
    if (!list.length && exp?.categoryId) return [Number(exp.categoryId)];
    return list;
  };

  const rows = bookings.map((bk) => {
    const exp = expById.get(bk.itemId) || null;
    const gst = toR(bk.gstPaise);
    // The rate this booking was actually charged at — derived from the money,
    // so a later rule change can't rewrite history. Falls back to the
    // experience's current rate for zero-GST bookings.
    const taxable = toR(bk.subtotalPaise);
    const derived = taxable > 0 ? Math.round((gst / taxable) * 100) : 0;
    const rate = gst > 0 ? derived : 0;
    return {
      bk,
      exp,
      date: new Date(revDate(bk)),
      gst,
      taxable,
      revenue: toR(bk.totalPaise),
      guests: num(bk.guestCount) || 1,
      rate,
      mode: (exp?.gstConfig && exp.gstConfig.mode) || 'global',
      supplierIncluded: !!exp?.pricing?.gstIncluded,
      city: exp?.city || exp?.location || bk.itemSnapshot?.location || null,
      categoryIds: catsOf(exp),
      audienceIds: Array.isArray(exp?.audiences) ? exp.audiences.map(Number) : [],
      supplierId: exp?.supplierId || null,
    };
  });

  const passes = (r) => {
    if (fExperience && r.bk.itemId !== fExperience) return false;
    if (fCategory && !r.categoryIds.includes(fCategory)) return false;
    if (fAudience && !r.audienceIds.includes(fAudience)) return false;
    if (fSupplier && r.supplierId !== fSupplier) return false;
    if (fCity && r.city !== fCity) return false;
    if (fRate != null && r.rate !== fRate) return false;
    if (fMode && r.mode !== fMode) return false;
    return true;
  };

  const inRange = (r, s, e) => r.date >= s && r.date <= e;
  const current = rows.filter((r) => passes(r) && inRange(r, start, end));
  const previous = rows.filter((r) => passes(r) && inRange(r, prevStart, prevEnd));

  const sum = (list, key) => list.reduce((acc, r) => acc + r[key], 0);
  const totalGst = sum(current, 'gst');
  const totalTaxable = sum(current, 'taxable');
  const totalRevenue = sum(current, 'revenue');
  const totalGuests = sum(current, 'guests');
  const prevGst = sum(previous, 'gst');
  const zeroRated = current.filter((r) => r.gst <= 0).length;

  const totals = {
    gst: r2(totalGst),
    taxable: r2(totalTaxable),
    revenue: r2(totalRevenue),
    bookings: current.length,
    guests: totalGuests,
    avgGstPerBooking: current.length ? r2(totalGst / current.length) : 0,
    // Blended rate actually realised across the period.
    effectiveRate: totalTaxable ? r2((totalGst / totalTaxable) * 100) : 0,
    shareOfRevenue: totalRevenue ? r2((totalGst / totalRevenue) * 100) : 0,
    zeroRatedBookings: zeroRated,
  };
  const delta = prevGst ? r2(((totalGst - prevGst) / prevGst) * 100) : null;

  const buckets = enumerateBuckets(start, end, interval);
  const byBucket = new Map(buckets.map((b) => [b, { bucket: b, gst: 0, taxable: 0, revenue: 0, bookings: 0 }]));
  current.forEach((r) => {
    const cur = byBucket.get(bucketOf(r.date, interval));
    if (!cur) return;
    cur.gst += r.gst; cur.taxable += r.taxable; cur.revenue += r.revenue; cur.bookings += 1;
  });
  const series = [...byBucket.values()].map((s) => ({
    ...s, gst: r2(s.gst), taxable: r2(s.taxable), revenue: r2(s.revenue),
  }));

  const actMap = new Map(); const catMap = new Map(); const audMap = new Map();
  const cityMap = new Map(); const supMap = new Map(); const rateMap = new Map(); const modeMap = new Map();
  current.forEach((r) => {
    const patch = { gst: r.gst, taxable: r.taxable, revenue: r.revenue, guests: r.guests };
    addTo(actMap, r.bk.itemId, r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}`, patch);
    r.categoryIds.forEach((id) => addTo(catMap, id, catName.get(id) || `#${id}`, patch));
    r.audienceIds.forEach((id) => addTo(audMap, id, audName.get(id) || `#${id}`, patch));
    if (r.city) addTo(cityMap, r.city, r.city, patch);
    if (r.supplierId) addTo(supMap, r.supplierId, supName.get(r.supplierId) || `#${r.supplierId}`, patch);
    addTo(rateMap, r.rate, r.rate > 0 ? `${r.rate}% GST` : 'No GST charged', patch);
    addTo(modeMap, r.mode, MODE_LABEL[r.mode] || r.mode, patch);
  });

  const detail = current
    .slice()
    .sort((a, b) => b.date - a.date)
    .slice(0, 300)
    .map((r) => ({
      id: r.bk.id,
      code: r.bk.bookingCode,
      guest: r.bk.guestName,
      experienceId: r.bk.itemId,
      experience: r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}`,
      city: r.city,
      date: r.date,
      scheduledFor: r.bk.scheduledFor,
      guests: r.guests,
      rate: r.rate,
      mode: r.mode,
      modeLabel: MODE_LABEL[r.mode] || r.mode,
      supplierIncluded: r.supplierIncluded,
      taxable: r2(r.taxable),
      gst: r2(r.gst),
      revenue: r2(r.revenue),
    }));

  const windowAll = rows.filter((r) => inRange(r, start, end));
  const uniq = (arr) => [...new Map(arr.map((x) => [x.id, x])).values()];

  return ok(res, {
    range: { start: dstr(start), end: dstr(end), interval },
    totals,
    delta,
    previous: { gst: r2(prevGst), bookings: previous.length },
    series,
    byActivity: listOf(actMap),
    byCategory: listOf(catMap),
    byAudience: listOf(audMap),
    byCity: listOf(cityMap),
    bySupplier: listOf(supMap),
    byRate: listOf(rateMap),
    byMode: listOf(modeMap),
    bookings: detail,
    filters: {
      cities: [...new Set(windowAll.map((r) => r.city).filter(Boolean))].sort(),
      categories: uniq(windowAll.flatMap((r) => r.categoryIds.map((id) => ({ id, name: catName.get(id) || `#${id}` })))),
      audiences: uniq(windowAll.flatMap((r) => r.audienceIds.map((id) => ({ id, name: audName.get(id) || `#${id}` })))),
      experiences: uniq(windowAll.map((r) => ({ id: r.bk.itemId, name: r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}` }))),
      suppliers: uniq(windowAll.filter((r) => r.supplierId).map((r) => ({ id: r.supplierId, name: supName.get(r.supplierId) || `#${r.supplierId}` }))),
      rates: [...new Set(windowAll.map((r) => r.rate))].sort((a, b) => a - b),
      modes: [...new Set(windowAll.map((r) => r.mode))].map((m) => ({ id: m, name: MODE_LABEL[m] || m })),
    },
  });
});

module.exports = { gstAnalytics };

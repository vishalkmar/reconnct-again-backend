const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Booking, Experience, ExperienceCategory, ExperienceAudience, Supplier,
} = require('../models');
const { ok } = require('../utils/response');

/*
  Markup analytics — "how much markup did we actually earn?"

  Markup is the margin the admin's Markup Management rules add on top of the
  supplier's B2B base. It is charged for real (services/booking.service.js adds
  it into the unit price), so every PAID booking carries some of it.

  Per booking:
      quantity        = subtotalPaise / unitPricePaise   (guests / units billed)
      markupPerUnit   = the per-unit margin at booking time
      markup earned   = markupPerUnit × quantity

  `markupPerUnit` is snapshotted onto the booking from now on
  (itemSnapshot.pricedAt.markupPerUnit) so a later rule change never rewrites
  history. Bookings taken before that snapshot existed fall back to the
  experience's CURRENT markup config — flagged as `estimated` in the response so
  the dashboard can be honest about it.

  Only `itemType: 'experience'` bookings can carry markup; packages/rooms/events
  are out of scope by definition.
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

// The per-unit markup baked into what the customer paid.
const markupPerUnitOf = (bk, exp) => {
  const snap = bk.itemSnapshot?.pricedAt || {};
  if (snap.markupPerUnit != null) return { value: num(snap.markupPerUnit), estimated: false, type: snap.markup?.type || null };
  // Legacy booking — reconstruct from the experience's current markup config.
  if (!exp || !exp.markup || !exp.markup.value) return { value: 0, estimated: false, type: null };
  const base = num(exp.pricing?.adultPrice || exp.pricing?.fromPrice);
  const m = exp.markup;
  const per = m.type === 'fixed' ? num(m.value) : (base * num(m.value)) / 100;
  return { value: per, estimated: true, type: m.type };
};

const quantityOf = (bk) => {
  const unit = num(bk.unitPricePaise);
  if (unit > 0) return Math.max(1, Math.round(num(bk.subtotalPaise) / unit));
  return Math.max(1, num(bk.guestCount) || 1);
};

const addTo = (map, key, label, patch) => {
  if (key == null) return;
  const cur = map.get(key) || { key, name: label, markup: 0, base: 0, revenue: 0, bookings: 0, guests: 0 };
  cur.markup += patch.markup;
  cur.base += patch.base;
  cur.revenue += patch.revenue;
  cur.bookings += 1;
  cur.guests += patch.guests;
  map.set(key, cur);
};

const listOf = (map) => [...map.values()]
  .map((v) => ({ ...v, markup: r2(v.markup), base: r2(v.base), revenue: r2(v.revenue) }))
  .sort((a, b) => b.markup - a.markup);

// GET /api/admin/pricing-setup/markup/analytics
const markupAnalytics = asyncHandler(async (req, res) => {
  const now = new Date();
  const end = req.query.end ? new Date(`${req.query.end}T23:59:59`) : now;
  const start = req.query.start ? new Date(`${req.query.start}T00:00:00`)
    : new Date(new Date(end).setMonth(end.getMonth() - 3));

  const spanDays = (end - start) / (1000 * 60 * 60 * 24);
  const interval = ['day', 'week', 'month'].includes(req.query.interval)
    ? req.query.interval
    : (spanDays > 120 ? 'month' : (spanDays <= 31 ? 'day' : 'week'));

  // Same-length preceding window, for the "vs previous period" deltas.
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
      'unitPricePaise', 'subtotalPaise', 'totalPaise', 'paidAt', 'createdAt', 'scheduledFor'],
    order: [['createdAt', 'ASC']],
  });

  // Hydrate the experiences these bookings point at (taxonomy + fallback markup).
  const expIds = [...new Set(bookings.map((b) => b.itemId))];
  const exps = expIds.length
    ? await Experience.findAll({
      where: { id: { [Op.in]: expIds } },
      attributes: ['id', 'name', 'city', 'location', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup', 'supplierId'],
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

  // ── Filters ──────────────────────────────────────────────────────────────
  const fCategory = req.query.categoryId ? Number(req.query.categoryId) : null;
  const fAudience = req.query.audienceId ? Number(req.query.audienceId) : null;
  const fExperience = req.query.experienceId ? Number(req.query.experienceId) : null;
  const fSupplier = req.query.supplierId ? Number(req.query.supplierId) : null;
  const fCity = req.query.city ? String(req.query.city) : null;
  const fType = ['percentage', 'fixed'].includes(req.query.markupType) ? req.query.markupType : null;

  const cityOf = (bk, exp) => (exp?.city || exp?.location || bk.itemSnapshot?.location || null);
  const catsOf = (exp) => {
    const list = Array.isArray(exp?.categoryIds) ? exp.categoryIds.map(Number) : [];
    if (!list.length && exp?.categoryId) return [Number(exp.categoryId)];
    return list;
  };
  const audsOf = (exp) => (Array.isArray(exp?.audiences) ? exp.audiences.map(Number) : []);

  // One enriched row per booking — computed once, reused by every rollup.
  const rows = bookings.map((bk) => {
    const exp = expById.get(bk.itemId) || null;
    const per = markupPerUnitOf(bk, exp);
    const qty = quantityOf(bk);
    const markup = per.value * qty;
    return {
      bk,
      exp,
      date: new Date(revDate(bk)),
      markup,
      markupPerUnit: per.value,
      markupType: per.type,
      estimated: per.estimated,
      base: toR(bk.subtotalPaise) - markup, // supplier's B2B share
      subtotal: toR(bk.subtotalPaise),
      revenue: toR(bk.totalPaise),
      guests: num(bk.guestCount) || 1,
      city: cityOf(bk, exp),
      categoryIds: catsOf(exp),
      audienceIds: audsOf(exp),
      supplierId: exp?.supplierId || null,
    };
  });

  const passes = (r) => {
    if (fExperience && r.bk.itemId !== fExperience) return false;
    if (fCategory && !r.categoryIds.includes(fCategory)) return false;
    if (fAudience && !r.audienceIds.includes(fAudience)) return false;
    if (fSupplier && r.supplierId !== fSupplier) return false;
    if (fCity && r.city !== fCity) return false;
    if (fType && r.markupType !== fType) return false;
    return true;
  };

  const inRange = (r, s, e) => r.date >= s && r.date <= e;
  const current = rows.filter((r) => passes(r) && inRange(r, start, end));
  const previous = rows.filter((r) => passes(r) && inRange(r, prevStart, prevEnd));

  // ── Totals ───────────────────────────────────────────────────────────────
  const sum = (list, key) => list.reduce((acc, r) => acc + r[key], 0);
  const totalMarkup = sum(current, 'markup');
  const totalBase = sum(current, 'base');
  const totalRevenue = sum(current, 'revenue');
  const totalGuests = sum(current, 'guests');
  const prevMarkup = sum(previous, 'markup');
  const estimatedCount = current.filter((r) => r.estimated && r.markup > 0).length;

  const totals = {
    markup: r2(totalMarkup),
    supplierBase: r2(totalBase),
    revenue: r2(totalRevenue),
    bookings: current.length,
    guests: totalGuests,
    avgMarkupPerBooking: current.length ? r2(totalMarkup / current.length) : 0,
    avgMarkupPerGuest: totalGuests ? r2(totalMarkup / totalGuests) : 0,
    // Markup as a share of what the supplier gets, and of what the customer pays.
    marginOnBase: totalBase ? r2((totalMarkup / totalBase) * 100) : 0,
    shareOfRevenue: totalRevenue ? r2((totalMarkup / totalRevenue) * 100) : 0,
    estimatedBookings: estimatedCount,
  };
  const delta = prevMarkup ? r2(((totalMarkup - prevMarkup) / prevMarkup) * 100) : null;

  // ── Trend ────────────────────────────────────────────────────────────────
  const buckets = enumerateBuckets(start, end, interval);
  const byBucket = new Map(buckets.map((b) => [b, { bucket: b, markup: 0, base: 0, revenue: 0, bookings: 0 }]));
  current.forEach((r) => {
    const key = bucketOf(r.date, interval);
    const cur = byBucket.get(key);
    if (!cur) return;
    cur.markup += r.markup; cur.base += r.base; cur.revenue += r.revenue; cur.bookings += 1;
  });
  const series = [...byBucket.values()].map((s) => ({
    ...s, markup: r2(s.markup), base: r2(s.base), revenue: r2(s.revenue),
  }));

  // ── Breakdowns ───────────────────────────────────────────────────────────
  const actMap = new Map(); const catMap = new Map(); const audMap = new Map();
  const cityMap = new Map(); const supMap = new Map(); const typeMap = new Map();
  current.forEach((r) => {
    const patch = { markup: r.markup, base: r.base, revenue: r.revenue, guests: r.guests };
    addTo(actMap, r.bk.itemId, r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}`, patch);
    r.categoryIds.forEach((id) => addTo(catMap, id, catName.get(id) || `#${id}`, patch));
    r.audienceIds.forEach((id) => addTo(audMap, id, audName.get(id) || `#${id}`, patch));
    if (r.city) addTo(cityMap, r.city, r.city, patch);
    if (r.supplierId) addTo(supMap, r.supplierId, supName.get(r.supplierId) || `#${r.supplierId}`, patch);
    addTo(typeMap, r.markupType || 'none', r.markupType === 'fixed' ? 'Flat ₹' : (r.markupType === 'percentage' ? 'Percentage %' : 'No markup'), patch);
  });

  // ── Booking-level table (newest first, capped) ───────────────────────────
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
      markupPerUnit: r2(r.markupPerUnit),
      markupType: r.markupType,
      markup: r2(r.markup),
      base: r2(r.base),
      revenue: r2(r.revenue),
      estimated: r.estimated,
    }));

  // Filter universes — from ALL rows in the window, before filtering, so the
  // dropdowns never collapse to whatever is currently selected.
  const windowAll = rows.filter((r) => inRange(r, start, end));
  const uniq = (arr) => [...new Map(arr.map((x) => [x.id, x])).values()];

  return ok(res, {
    range: { start: dstr(start), end: dstr(end), interval },
    totals,
    delta,
    previous: { markup: r2(prevMarkup), bookings: previous.length },
    series,
    byActivity: listOf(actMap),
    byCategory: listOf(catMap),
    byAudience: listOf(audMap),
    byCity: listOf(cityMap),
    bySupplier: listOf(supMap),
    byType: listOf(typeMap),
    bookings: detail,
    filters: {
      cities: [...new Set(windowAll.map((r) => r.city).filter(Boolean))].sort(),
      categories: uniq(windowAll.flatMap((r) => r.categoryIds.map((id) => ({ id, name: catName.get(id) || `#${id}` })))),
      audiences: uniq(windowAll.flatMap((r) => r.audienceIds.map((id) => ({ id, name: audName.get(id) || `#${id}` })))),
      experiences: uniq(windowAll.map((r) => ({ id: r.bk.itemId, name: r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}` }))),
      suppliers: uniq(windowAll.filter((r) => r.supplierId).map((r) => ({ id: r.supplierId, name: supName.get(r.supplierId) || `#${r.supplierId}` }))),
    },
  });
});

module.exports = { markupAnalytics };

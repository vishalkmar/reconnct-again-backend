const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Coupon, Booking, Experience, ExperienceCategory, ExperienceAudience,
} = require('../models');
const { ok, created, fail } = require('../utils/response');

/*
  Admin "Pricing Setup Management → Discount Management".

  Discount works differently from the other three modules on purpose: a markup /
  GST / convenience rule silently changes a price, whereas a discount is
  something the CUSTOMER redeems. So a discount rule here IS a coupon:

     pick a scope  →  pick the rate  →  GENERATE THE COUPON CODE  →  apply

  Nothing can be saved until a code exists, because a discount with no code
  could never be redeemed by anyone. The coupon then rides the platform's
  existing redemption path (services/referEarn.validateCouponFor), which now
  also checks the coupon's scope against the experience being booked and takes
  the discount off the FINAL amount — after markup, GST and convenience fee.

  There is deliberately no "latest wins" here: coupons don't compete with each
  other, the customer types the one they hold.
*/

const SCOPES = ['all', 'category', 'audience', 'experience'];
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const toPaise = (rupees) => Math.round(num(rupees) * 100);
const fromPaise = (p) => num(p) / 100;

// Unambiguous alphabet — no O/0/I/1 so a code read off a screen can't be mistyped.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPart = (n = 5) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const makeCode = async (prefix = 'RECONNCT') => {
  const clean = String(prefix || 'RECONNCT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'RECONNCT';
  for (let i = 0; i < 25; i += 1) {
    const candidate = `${clean}-${randomPart(5)}`;
    // eslint-disable-next-line no-await-in-loop
    const taken = await Coupon.findOne({ where: { code: candidate }, attributes: ['id'] });
    if (!taken) return candidate;
  }
  return `${clean}-${Date.now().toString(36).toUpperCase()}`;
};

const labelTargets = async (coupons) => {
  const catIds = new Set(); const audIds = new Set(); const expIds = new Set();
  coupons.forEach((c) => {
    const t = Array.isArray(c.targetIds) ? c.targetIds.map(Number) : [];
    if (c.scope === 'category') t.forEach((i) => catIds.add(i));
    if (c.scope === 'audience') t.forEach((i) => audIds.add(i));
    if (c.scope === 'experience') t.forEach((i) => expIds.add(i));
  });
  const [cats, auds, exps] = await Promise.all([
    catIds.size ? ExperienceCategory.findAll({ where: { id: [...catIds] }, attributes: ['id', 'name'] }) : [],
    audIds.size ? ExperienceAudience.findAll({ where: { id: [...audIds] }, attributes: ['id', 'name'] }) : [],
    expIds.size ? Experience.findAll({ where: { id: [...expIds] }, attributes: ['id', 'name'] }) : [],
  ]);
  const map = {
    category: new Map(cats.map((c) => [c.id, c.name])),
    audience: new Map(auds.map((a) => [a.id, a.name])),
    experience: new Map(exps.map((e) => [e.id, e.name])),
  };
  return (c) => {
    if (c.scope === 'all') return ['All experiences'];
    const t = Array.isArray(c.targetIds) ? c.targetIds.map(Number) : [];
    return t.map((id) => map[c.scope]?.get(id) || `#${id}`);
  };
};

const shape = (c, label) => {
  const j = c.toJSON ? c.toJSON() : c;
  return {
    id: j.id,
    code: j.code,
    scope: j.scope || 'all',
    targetIds: j.targetIds || [],
    targetNames: label(j),
    kind: j.kind, // percent | flat
    // Percent is a plain number; flat is stored in paise but shown in rupees.
    value: j.kind === 'percent' ? num(j.value) : fromPaise(j.value),
    maxDiscount: j.maxDiscountPaise ? fromPaise(j.maxDiscountPaise) : 0,
    minOrder: j.minOrderPaise ? fromPaise(j.minOrderPaise) : 0,
    usageLimit: j.usageLimit || 0,
    timesUsed: j.timesUsed || 0,
    expiresAt: j.expiresAt,
    description: j.description,
    isActive: j.isActive,
    createdByName: j.createdByName,
    createdAt: j.createdAt,
    expired: !!(j.expiresAt && new Date(j.expiresAt) < new Date()),
    exhausted: !!(j.usageLimit && (j.timesUsed || 0) >= j.usageLimit),
  };
};

// ── GET /discount/coupons ──────────────────────────────────────────────────
const listCoupons = asyncHandler(async (req, res) => {
  const coupons = await Coupon.findAll({
    where: { isDiscountRule: true },
    order: [['createdAt', 'DESC']],
  });
  const label = await labelTargets(coupons);
  return ok(res, { items: coupons.map((c) => shape(c, label)) });
});

// ── GET /discount/targets ──────────────────────────────────────────────────
const targets = asyncHandler(async (req, res) => {
  const [cats, auds, exps] = await Promise.all([
    ExperienceCategory.findAll({ where: { isActive: true }, attributes: ['id', 'name'], order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
    ExperienceAudience.findAll({ where: { isActive: true }, attributes: ['id', 'name'], order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
    Experience.findAll({
      where: { status: 'published', isActive: true },
      attributes: ['id', 'name', 'city', 'location', 'pricing'],
      order: [['name', 'ASC']],
    }),
  ]);
  return ok(res, {
    categories: cats.map((c) => ({ id: c.id, name: c.name })),
    audiences: auds.map((a) => ({ id: a.id, name: a.name })),
    experiences: exps.map((e) => ({
      id: e.id, name: e.name, city: e.city || e.location || '', basePrice: num(e.pricing?.adultPrice),
    })),
  });
});

// ── POST /discount/generate-code ───────────────────────────────────────────
// Hands back a fresh unique code WITHOUT saving anything. The admin sees the
// coupon card first and only then presses Apply, which is what actually
// creates it — so a code they abandon never clutters the list.
const generateCode = asyncHandler(async (req, res) => {
  const code = await makeCode(req.body.prefix);
  return ok(res, { code });
});

const validateBody = (body) => {
  const scope = String(body.scope || '').trim();
  if (!SCOPES.includes(scope)) return { error: 'Pick a valid scope' };

  const kind = body.kind === 'flat' ? 'flat' : 'percent';
  const value = num(body.value);
  if (value <= 0) return { error: 'Enter a discount value' };
  if (kind === 'percent' && value > 100) return { error: 'A percentage discount cannot be above 100%' };

  let targetIds = [];
  if (scope !== 'all') {
    targetIds = (Array.isArray(body.targetIds) ? body.targetIds : []).map(Number).filter((n) => n > 0);
    if (!targetIds.length) return { error: 'Select at least one target' };
  }

  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return { error: 'Generate a coupon code before applying the discount' };
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return { error: 'A coupon code can only use letters, numbers and hyphens' };

  return {
    data: {
      code,
      scope,
      targetIds,
      kind,
      // Percent stays a plain number; flat is stored in paise like every other
      // money column in this codebase.
      value: kind === 'percent' ? Math.round(value) : toPaise(value),
      maxDiscountPaise: kind === 'percent' && num(body.maxDiscount) > 0 ? toPaise(body.maxDiscount) : null,
      minOrderPaise: num(body.minOrder) > 0 ? toPaise(body.minOrder) : 0,
      usageLimit: Math.max(0, Math.round(num(body.usageLimit))) || 0,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      description: (body.description || '').trim() || null,
    },
  };
};

const who = (req) => (req.admin ? (req.admin.name || req.admin.email) : (req.teamMember ? req.teamMember.name : null));

// ── POST /discount/coupons ─────────────────────────────────────────────────
const createCoupon = asyncHandler(async (req, res) => {
  const { error, data } = validateBody(req.body);
  if (error) return fail(res, error, 400);

  const clash = await Coupon.findOne({ where: { code: data.code }, attributes: ['id'] });
  if (clash) return fail(res, 'That coupon code already exists — generate a new one', 400);

  const coupon = await Coupon.create({
    ...data,
    userId: null, // public: anyone holding the code can redeem it
    reason: 'promo',
    isDiscountRule: true,
    isActive: true,
    createdByAdminId: req.admin ? req.admin.id : null,
    createdByName: who(req),
  });
  const label = await labelTargets([coupon]);
  return created(res, { item: shape(coupon, label) }, `Coupon ${coupon.code} is live`);
});

// ── PUT /discount/coupons/:id ──────────────────────────────────────────────
const updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findByPk(req.params.id);
  if (!coupon || !coupon.isDiscountRule) return fail(res, 'Coupon not found', 404);

  const merged = { ...shape(coupon, () => []), ...req.body, code: req.body.code || coupon.code };
  const { error, data } = validateBody(merged);
  if (error) return fail(res, error, 400);

  if (data.code !== coupon.code) {
    const clash = await Coupon.findOne({ where: { code: data.code, id: { [Op.ne]: coupon.id } }, attributes: ['id'] });
    if (clash) return fail(res, 'That coupon code already exists', 400);
  }
  await coupon.update(data);
  const label = await labelTargets([coupon]);
  return ok(res, { item: shape(coupon, label) }, 'Coupon updated');
});

// ── PATCH /discount/coupons/:id/toggle ─────────────────────────────────────
const toggleCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findByPk(req.params.id);
  if (!coupon || !coupon.isDiscountRule) return fail(res, 'Coupon not found', 404);
  await coupon.update({ isActive: !coupon.isActive });
  return ok(res, { isActive: coupon.isActive }, coupon.isActive ? 'Coupon resumed' : 'Coupon paused');
});

// ── DELETE /discount/coupons/:id ───────────────────────────────────────────
const removeCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findByPk(req.params.id);
  if (!coupon || !coupon.isDiscountRule) return fail(res, 'Coupon not found', 404);
  // A coupon that has already been redeemed is deactivated rather than deleted,
  // so past bookings keep a code that still resolves to something.
  if ((coupon.timesUsed || 0) > 0) {
    await coupon.update({ isActive: false });
    return ok(res, { deactivated: true }, 'This coupon has been used before, so it was paused instead of deleted');
  }
  await coupon.destroy();
  return ok(res, {}, 'Coupon removed');
});

// ── GET /discount/analytics ────────────────────────────────────────────────
/*
  What the coupons actually gave away. Sourced from `booking.couponDiscountPaise`
  + `booking.couponCode`, so every figure is money genuinely taken off a paid
  booking rather than a projection.
*/
const PAID = ['confirmed', 'completed'];
const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const mondayOf = (input) => {
  const x = new Date(input);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
};
const bucketOf = (d, iv) => (iv === 'month' ? monthKey(new Date(d)) : (iv === 'day' ? dstr(new Date(d)) : dstr(mondayOf(d))));
const enumerateBuckets = (start, end, iv) => {
  const out = [];
  if (iv === 'month') {
    let y = start.getFullYear(); let m = start.getMonth();
    const ey = end.getFullYear(); const em = end.getMonth();
    while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad(m + 1)}`); m += 1; if (m > 11) { m = 0; y += 1; } }
  } else if (iv === 'day') {
    let cur = new Date(start); cur.setHours(0, 0, 0, 0);
    while (cur <= end) { out.push(dstr(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 1); }
  } else {
    let cur = mondayOf(start); const last = mondayOf(end);
    while (cur <= last) { out.push(dstr(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 7); }
  }
  return out;
};
const addTo = (map, key, name, patch) => {
  if (key == null) return;
  const cur = map.get(key) || { key, name, discount: 0, revenue: 0, bookings: 0, guests: 0 };
  cur.discount += patch.discount; cur.revenue += patch.revenue; cur.bookings += 1; cur.guests += patch.guests;
  map.set(key, cur);
};
const listOf = (map) => [...map.values()]
  .map((v) => ({ ...v, discount: r2(v.discount), revenue: r2(v.revenue) }))
  .sort((a, b) => b.discount - a.discount);

const discountAnalytics = asyncHandler(async (req, res) => {
  const now = new Date();
  const end = req.query.end ? new Date(`${req.query.end}T23:59:59`) : now;
  const start = req.query.start ? new Date(`${req.query.start}T00:00:00`)
    : new Date(new Date(end).setMonth(end.getMonth() - 3));
  const spanDays = (end - start) / 86400000;
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
    attributes: ['id', 'bookingCode', 'itemId', 'itemSnapshot', 'guestName', 'guestCount',
      'couponCode', 'couponDiscountPaise', 'subtotalPaise', 'totalPaise', 'paidAt', 'createdAt'],
    order: [['createdAt', 'ASC']],
  });

  const expIds = [...new Set(bookings.map((b) => b.itemId))];
  const exps = expIds.length
    ? await Experience.findAll({
      where: { id: { [Op.in]: expIds } },
      attributes: ['id', 'name', 'city', 'location', 'audiences', 'categoryId', 'categoryIds'],
    })
    : [];
  const expById = new Map(exps.map((e) => [e.id, e]));
  const [cats, auds] = await Promise.all([
    ExperienceCategory.findAll({ attributes: ['id', 'name'] }),
    ExperienceAudience.findAll({ attributes: ['id', 'name'] }),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const audName = new Map(auds.map((a) => [a.id, a.name]));

  const fCode = req.query.code ? String(req.query.code).toUpperCase() : null;
  const fCategory = req.query.categoryId ? Number(req.query.categoryId) : null;
  const fAudience = req.query.audienceId ? Number(req.query.audienceId) : null;
  const fExperience = req.query.experienceId ? Number(req.query.experienceId) : null;
  const fCity = req.query.city ? String(req.query.city) : null;

  const rows = bookings.map((bk) => {
    const exp = expById.get(bk.itemId) || null;
    const cids = Array.isArray(exp?.categoryIds) && exp.categoryIds.length
      ? exp.categoryIds.map(Number)
      : (exp?.categoryId ? [Number(exp.categoryId)] : []);
    return {
      bk,
      exp,
      date: new Date(bk.paidAt || bk.createdAt),
      discount: fromPaise(bk.couponDiscountPaise),
      revenue: fromPaise(bk.totalPaise),
      guests: num(bk.guestCount) || 1,
      code: bk.couponCode ? String(bk.couponCode).toUpperCase() : null,
      city: exp?.city || exp?.location || bk.itemSnapshot?.location || null,
      categoryIds: cids,
      audienceIds: Array.isArray(exp?.audiences) ? exp.audiences.map(Number) : [],
    };
  });

  const passes = (r) => {
    if (fCode && r.code !== fCode) return false;
    if (fExperience && r.bk.itemId !== fExperience) return false;
    if (fCategory && !r.categoryIds.includes(fCategory)) return false;
    if (fAudience && !r.audienceIds.includes(fAudience)) return false;
    if (fCity && r.city !== fCity) return false;
    return true;
  };
  const inRange = (r, s, e) => r.date >= s && r.date <= e;
  const current = rows.filter((r) => passes(r) && inRange(r, start, end));
  const previous = rows.filter((r) => passes(r) && inRange(r, prevStart, prevEnd));

  const sum = (l, k) => l.reduce((a, r) => a + r[k], 0);
  const totalDiscount = sum(current, 'discount');
  const totalRevenue = sum(current, 'revenue');
  const redeemed = current.filter((r) => r.discount > 0);
  const prevDiscount = sum(previous, 'discount');

  const totals = {
    discount: r2(totalDiscount),
    revenue: r2(totalRevenue),
    bookings: current.length,
    redeemedBookings: redeemed.length,
    guests: sum(current, 'guests'),
    avgDiscount: redeemed.length ? r2(totalDiscount / redeemed.length) : 0,
    // What share of the money customers would have paid was given away.
    discountRate: (totalRevenue + totalDiscount) ? r2((totalDiscount / (totalRevenue + totalDiscount)) * 100) : 0,
    redemptionRate: current.length ? r2((redeemed.length / current.length) * 100) : 0,
  };
  const delta = prevDiscount ? r2(((totalDiscount - prevDiscount) / prevDiscount) * 100) : null;

  const buckets = enumerateBuckets(start, end, interval);
  const byBucket = new Map(buckets.map((b) => [b, { bucket: b, discount: 0, revenue: 0, bookings: 0 }]));
  current.forEach((r) => {
    const cur = byBucket.get(bucketOf(r.date, interval));
    if (!cur) return;
    cur.discount += r.discount; cur.revenue += r.revenue; cur.bookings += 1;
  });
  const series = [...byBucket.values()].map((s) => ({ ...s, discount: r2(s.discount), revenue: r2(s.revenue) }));

  const codeMap = new Map(); const actMap = new Map(); const catMap = new Map();
  const audMap = new Map(); const cityMap = new Map();
  redeemed.forEach((r) => {
    const patch = { discount: r.discount, revenue: r.revenue, guests: r.guests };
    if (r.code) addTo(codeMap, r.code, r.code, patch);
    addTo(actMap, r.bk.itemId, r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}`, patch);
    r.categoryIds.forEach((id) => addTo(catMap, id, catName.get(id) || `#${id}`, patch));
    r.audienceIds.forEach((id) => addTo(audMap, id, audName.get(id) || `#${id}`, patch));
    if (r.city) addTo(cityMap, r.city, r.city, patch);
  });

  const detail = redeemed
    .slice()
    .sort((a, b) => b.date - a.date)
    .slice(0, 300)
    .map((r) => ({
      id: r.bk.id,
      code: r.bk.bookingCode,
      couponCode: r.code,
      guest: r.bk.guestName,
      experienceId: r.bk.itemId,
      experience: r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}`,
      city: r.city,
      date: r.date,
      guests: r.guests,
      discount: r2(r.discount),
      revenue: r2(r.revenue),
    }));

  const windowAll = rows.filter((r) => inRange(r, start, end));
  const uniq = (arr) => [...new Map(arr.map((x) => [x.id, x])).values()];

  return ok(res, {
    range: { start: dstr(start), end: dstr(end), interval },
    totals,
    delta,
    previous: { discount: r2(prevDiscount), bookings: previous.length },
    series,
    byCoupon: listOf(codeMap),
    byActivity: listOf(actMap),
    byCategory: listOf(catMap),
    byAudience: listOf(audMap),
    byCity: listOf(cityMap),
    bookings: detail,
    filters: {
      codes: [...new Set(windowAll.map((r) => r.code).filter(Boolean))].sort(),
      cities: [...new Set(windowAll.map((r) => r.city).filter(Boolean))].sort(),
      categories: uniq(windowAll.flatMap((r) => r.categoryIds.map((id) => ({ id, name: catName.get(id) || `#${id}` })))),
      audiences: uniq(windowAll.flatMap((r) => r.audienceIds.map((id) => ({ id, name: audName.get(id) || `#${id}` })))),
      experiences: uniq(windowAll.map((r) => ({ id: r.bk.itemId, name: r.exp?.name || r.bk.itemSnapshot?.name || `#${r.bk.itemId}` }))),
    },
  });
});

module.exports = {
  listCoupons,
  targets,
  generateCode,
  createCoupon,
  updateCoupon,
  toggleCoupon,
  removeCoupon,
  discountAnalytics,
};

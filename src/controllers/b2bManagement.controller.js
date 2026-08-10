const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Experience, Booking, Supplier, User, TeamMember, ExperienceCategory, ExperienceType,
} = require('../models');
const { ok, fail } = require('../utils/response');
const { withMarkup } = require('../utils/goLivePricing');

/*
  Admin "B2B Management" — a command centre over every LIVE experience.

  Key money definitions (confirmed with the user):
    • B2B revenue  = the BASE price (before the go-live GST/discount/convenience)
                     → the booking's `subtotalPaise`.
    • B2C revenue  = the FINAL price the customer actually paid (extras applied)
                     → the booking's `totalPaise`.
    • "Difference in B2B and B2C" = B2C − B2B (the margin the extras created).
  Only PAID bookings count toward revenue; all bookings count toward counts.
*/
const PAID = ['confirmed', 'completed'];
const toR = (paise) => Number(paise || 0) / 100;

// A booking is "paid" once its lifecycle status reaches confirmed/completed
// (pending_payment / cancelled / refunded are not paid). The booking `status`
// column is the authoritative signal — there is no separate paymentStatus.
const isPaid = (bk) => PAID.includes(bk.status);

// The final per-adult price = base B2B + markup + GST + convenience, less any %-discount.
const finalAdultPrice = (exp) => {
  const raw = Number(exp.pricing?.adultPrice) || 0;
  if (raw <= 0) return 0;
  const base = withMarkup(raw, exp.markup); // markup applies first, on the base
  const disc = exp.discount;
  let d = 0;
  if (disc && disc.value) d = disc.type === 'percentage' ? (base * Number(disc.value)) / 100 : Number(disc.value) || 0;
  const net = Math.max(0, base - d);
  const gst = (net * (Number(exp.gstRate) || 0)) / 100;
  const afterGst = net + gst;
  const cf = exp.convenienceFee;
  let c = 0;
  if (cf && cf.type && cf.type !== 'free') c = cf.type === 'percentage' ? (afterGst * Number(cf.value)) / 100 : Number(cf.value) || 0;
  return Math.round(afterGst + c);
};

const revenueOf = (bookings) => {
  let b2b = 0; let b2c = 0; let count = 0; let paid = 0;
  for (const bk of bookings) {
    count += 1;
    if (isPaid(bk)) {
      paid += 1;
      b2b += toR(bk.subtotalPaise);
      b2c += toR(bk.totalPaise);
    }
  }
  return {
    b2b: Math.round(b2b), b2c: Math.round(b2c), difference: Math.round(b2c - b2b), bookings: count, paidBookings: paid,
  };
};

// Resolve the KAM (account manager) for an experience: the supplier's, else the
// host owner's.
const kamFor = async (exp) => {
  let kamId = null;
  if (exp.supplierId) {
    const s = await Supplier.findByPk(exp.supplierId, { attributes: ['accountManagerId'] });
    kamId = s && s.accountManagerId;
  }
  if (!kamId && exp.ownerUserId) {
    const u = await User.findByPk(exp.ownerUserId, { attributes: ['accountManagerId'] });
    kamId = u && u.accountManagerId;
  }
  if (!kamId) return null;
  const km = await TeamMember.findByPk(kamId, {
    attributes: ['id', 'name', 'email', 'phone', 'employeeCode', 'roleType'],
  });
  return km ? km.toJSON() : null;
};

const bookingRow = (bk) => ({
  id: bk.id,
  code: bk.bookingCode,
  guest: bk.guestName,
  email: bk.guestEmail,
  phone: bk.guestPhone,
  guestCount: bk.guestCount,
  date: bk.scheduledFor,
  bookedAt: bk.createdAt,
  paidAt: bk.paidAt,
  status: bk.status,
  paymentStatus: isPaid(bk) ? 'paid' : (bk.status === 'cancelled' ? 'cancelled' : 'pending'),
  b2b: toR(bk.subtotalPaise), // base
  b2c: toR(bk.totalPaise), // final (customer paid)
  difference: toR(bk.totalPaise) - toR(bk.subtotalPaise),
});

// GET /api/admin/b2b/experiences — LIVE listings only, with booking + revenue rollup.
const listLive = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: { status: 'published', isActive: true },
    attributes: ['id', 'name', 'city', 'location', 'mainImage', 'supplierId', 'ownerUserId', 'pricing', 'gstRate', 'discount', 'convenienceFee', 'updatedAt', 'data'],
    include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'companyName'] }],
    order: [['updatedAt', 'DESC']],
  });
  const ids = rows.map((r) => r.id);
  const bks = ids.length
    ? await Booking.findAll({ where: { itemType: 'experience', itemId: { [Op.in]: ids } }, attributes: ['itemId', 'status', 'subtotalPaise', 'totalPaise'] })
    : [];
  const byExp = new Map();
  bks.forEach((bk) => { const a = byExp.get(bk.itemId) || []; a.push(bk); byExp.set(bk.itemId, a); });

  const items = rows.map((r) => {
    const j = r.toJSON();
    const rev = revenueOf(byExp.get(r.id) || []);
    return {
      id: j.id,
      name: j.name,
      city: j.city || j.location || '',
      image: j.mainImage,
      supplier: (j.supplier && j.supplier.companyName) || (j.ownerUserId ? 'Host listing' : '—'),
      listedAt: (j.data && j.data.listedAt) || j.updatedAt,
      fromPrice: finalAdultPrice(j),
      ...rev,
    };
  });
  return ok(res, { items });
});

// GET /api/admin/b2b/experiences/:id — full command centre for one live experience.
const detail = asyncHandler(async (req, res) => {
  const exp = await Experience.findByPk(req.params.id, {
    include: [
      { model: Supplier, as: 'supplier' },
      { model: ExperienceCategory, as: 'category', attributes: ['id', 'name'] },
      { model: ExperienceType, as: 'type', attributes: ['id', 'name'] },
    ],
  });
  if (!exp) return fail(res, 'Experience not found', 404);
  const j = exp.toJSON();
  const kam = await kamFor(exp);
  const bookings = await Booking.findAll({
    where: { itemType: 'experience', itemId: exp.id },
    attributes: ['id', 'bookingCode', 'guestName', 'guestEmail', 'guestPhone', 'guestCount', 'subtotalPaise', 'totalPaise', 'status', 'paidAt', 'scheduledFor', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });
  const rev = revenueOf(bookings);

  return ok(res, {
    experience: j, // full details (same shape the listing shows)
    supplier: j.supplier || null,
    kam,
    pricing: {
      priceMethod: j.priceMethod,
      pricing: j.pricing || {}, // B2B base (adult + child bands)
      gstRate: j.gstRate || 0,
      markup: j.markup || null,
      discount: j.discount || null,
      convenienceFee: j.convenienceFee || null,
      b2cPriceMethod: j.b2cPriceMethod,
      b2cPricing: j.b2cPricing || {}, // reference the adder entered
      finalAdultPrice: finalAdultPrice(j), // what a customer pays per adult
    },
    bookings: bookings.map(bookingRow),
    revenue: rev,
    meta: {
      listedAt: (j.data && j.data.listedAt) || j.updatedAt,
      bookings: rev.bookings,
      paidBookings: rev.paidBookings,
    },
  });
});

// GET /api/admin/b2b/tally — global payment tally with B2B/B2C totals + difference.
// Filters: from, to (paid date), name, email, supplier, experienceId.
const tally = asyncHandler(async (req, res) => {
  const {
    from, to, name, email, supplier, experienceId,
  } = req.query;

  const where = { itemType: 'experience' };
  if (experienceId) where.itemId = Number(experienceId);
  if (name) where.guestName = { [Op.like]: `%${name}%` };
  if (email) where.guestEmail = { [Op.like]: `%${email}%` };
  // Date range on when it was booked/paid.
  if (from || to) {
    const range = {};
    if (from) range[Op.gte] = new Date(`${from}T00:00:00`);
    if (to) range[Op.lte] = new Date(`${to}T23:59:59`);
    where.createdAt = range;
  }

  const bookings = await Booking.findAll({
    where,
    attributes: ['id', 'bookingCode', 'itemId', 'itemSnapshot', 'guestName', 'guestEmail', 'guestPhone', 'guestCount', 'subtotalPaise', 'totalPaise', 'status', 'paidAt', 'scheduledFor', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });

  // Map experiences → supplier for the supplier filter + activity labels.
  const expIds = [...new Set(bookings.map((b) => b.itemId))];
  const exps = expIds.length
    ? await Experience.findAll({ where: { id: { [Op.in]: expIds } }, attributes: ['id', 'name', 'supplierId'], include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'companyName'] }] })
    : [];
  const expMap = new Map(exps.map((e) => [e.id, { name: e.name, supplier: e.supplier ? e.supplier.companyName : null }]));

  let rows = bookings.map((bk) => {
    const meta = expMap.get(bk.itemId) || {};
    return {
      ...bookingRow(bk),
      experienceId: bk.itemId,
      experience: meta.name || (bk.itemSnapshot && bk.itemSnapshot.name) || `#${bk.itemId}`,
      supplier: meta.supplier || '—',
    };
  });
  if (supplier) {
    const q = String(supplier).toLowerCase();
    rows = rows.filter((r) => (r.supplier || '').toLowerCase().includes(q));
  }

  const totalCount = rows.length; // all statuses, for context
  // Only PAID bookings count toward the tally — pending/cancelled are excluded
  // from the totals, the graphs AND the listing.
  const paidRows = rows.filter((r) => r.paymentStatus === 'paid');
  const b2bTotal = Math.round(paidRows.reduce((s, r) => s + r.b2b, 0));
  const b2cTotal = Math.round(paidRows.reduce((s, r) => s + r.b2c, 0));

  // Grouped rollups.
  const byActivity = {};
  const byDate = {};
  paidRows.forEach((r) => {
    const a = byActivity[r.experience] || { experience: r.experience, b2b: 0, b2c: 0, bookings: 0 };
    a.b2b += r.b2b; a.b2c += r.b2c; a.bookings += 1; byActivity[r.experience] = a;
    const d = (r.paidAt || r.bookedAt || '').toString().slice(0, 10);
    const dd = byDate[d] || { date: d, b2b: 0, b2c: 0, bookings: 0 };
    dd.b2b += r.b2b; dd.b2c += r.b2c; dd.bookings += 1; byDate[d] = dd;
  });
  const round = (o) => ({ ...o, b2b: Math.round(o.b2b), b2c: Math.round(o.b2c), difference: Math.round(o.b2c - o.b2b) });

  return ok(res, {
    totals: {
      b2b: b2bTotal,
      b2c: b2cTotal,
      difference: b2cTotal - b2bTotal,
      bookings: totalCount,
      paidBookings: paidRows.length,
    },
    rows: paidRows, // listing shows only paid bookings
    byActivity: Object.values(byActivity).map(round).sort((a, b) => b.b2c - a.b2c),
    byDate: Object.values(byDate).map(round).sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
});

// GET /api/admin/b2b/supplier-revenue — per-supplier B2B vs B2C rollup over all
// PAID experience bookings. B2B = base (subtotalPaise), B2C = final paid
// (totalPaise); Difference = B2C − B2B.
const supplierRevenue = asyncHandler(async (req, res) => {
  const bookings = await Booking.findAll({
    where: { itemType: 'experience' },
    attributes: ['itemId', 'status', 'subtotalPaise', 'totalPaise'],
  });
  const expIds = [...new Set(bookings.map((b) => b.itemId))];
  const exps = expIds.length
    ? await Experience.findAll({ where: { id: { [Op.in]: expIds } }, attributes: ['id', 'supplierId'] })
    : [];
  const expSup = new Map(exps.map((e) => [e.id, e.supplierId]));

  const bySup = new Map();
  for (const b of bookings) {
    if (!isPaid(b)) continue;
    const sid = expSup.get(b.itemId);
    if (!sid) continue;
    const r = bySup.get(sid) || { supplierId: sid, b2b: 0, b2c: 0, bookings: 0 };
    r.b2b += toR(b.subtotalPaise); r.b2c += toR(b.totalPaise); r.bookings += 1;
    bySup.set(sid, r);
  }
  const items = [...bySup.values()].map((r) => ({
    supplierId: r.supplierId,
    b2b: Math.round(r.b2b),
    b2c: Math.round(r.b2c),
    difference: Math.round(r.b2c - r.b2b),
    bookings: r.bookings,
  }));
  return ok(res, { items });
});

// GET /api/admin/b2b/supplier-revenue/:id — one supplier's paid bookings, each
// valued at both B2B (base) and B2C (paid), for the side-by-side split view.
const supplierRevenueDetail = asyncHandler(async (req, res) => {
  const supplierId = Number(req.params.id);
  const sup = await Supplier.findByPk(supplierId, { attributes: ['id', 'companyName', 'supplierName'] });
  const exps = await Experience.findAll({ where: { supplierId }, attributes: ['id', 'name'] });
  const expMap = new Map(exps.map((e) => [e.id, e.name]));
  const ids = exps.map((e) => e.id);
  const bookings = ids.length
    ? await Booking.findAll({
      where: { itemType: 'experience', itemId: { [Op.in]: ids } },
      attributes: ['id', 'bookingCode', 'guestName', 'guestEmail', 'guestCount', 'subtotalPaise', 'totalPaise', 'status', 'paidAt', 'scheduledFor', 'createdAt', 'itemId'],
      order: [['createdAt', 'DESC']],
    })
    : [];
  const rows = bookings.filter(isPaid).map((b) => ({
    code: b.bookingCode,
    guest: b.guestName,
    email: b.guestEmail,
    guests: b.guestCount,
    experience: expMap.get(b.itemId) || `#${b.itemId}`,
    date: b.scheduledFor,
    bookedAt: b.createdAt,
    b2b: r0Money(b.subtotalPaise),
    b2c: r0Money(b.totalPaise),
    difference: r0Money(b.totalPaise) - r0Money(b.subtotalPaise),
  }));
  const b2b = Math.round(rows.reduce((s, r) => s + r.b2b, 0));
  const b2c = Math.round(rows.reduce((s, r) => s + r.b2c, 0));
  return ok(res, {
    supplier: sup ? sup.toJSON() : { id: supplierId, companyName: `Supplier #${supplierId}` },
    totals: { b2b, b2c, difference: b2c - b2b, bookings: rows.length },
    rows,
  });
});
const r0Money = (paise) => Math.round(toR(paise));

module.exports = {
  listLive, detail, tally, supplierRevenue, supplierRevenueDetail,
};

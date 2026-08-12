const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Booking, User, Experience, ExperienceCategory,
} = require('../models');
const { ok, fail } = require('../utils/response');
const { fromPaise } = require('../services/booking.service');
const { publicBooking } = require('./booking.controller');

// Same shape the user-side controller returns, but with the user snapshot
// inlined so the admin UI can render full traveller context without an
// extra join on the client.
const adminBookingShape = (booking) => {
  if (!booking) return null;
  const base = publicBooking(booking);
  const userJson = booking.user ? (booking.user.toJSON ? booking.user.toJSON() : booking.user) : null;
  return {
    ...base,
    user: userJson ? {
      id: userJson.id,
      name: userJson.name,
      email: userJson.email,
      phone: userJson.phone,
      avatarUrl: userJson.avatarUrl,
      referralCode: userJson.referralCode,
      isProfileComplete: !!userJson.isProfileComplete,
      createdAt: userJson.createdAt,
      lastLoginAt: userJson.lastLoginAt,
    } : null,
  };
};

// Shared search/date/type conditions (everything except status/paidOnly),
// so the "how much is pending" stat can be computed on the same filters even
// when the main query itself is gated to paid-only (the Transactions page).
const searchConditions = (req) => {
  const cond = {};
  if (req.query.itemType) cond.itemType = String(req.query.itemType);
  if (req.query.from || req.query.to) {
    cond.scheduledFor = {};
    if (req.query.from) cond.scheduledFor[Op.gte] = String(req.query.from);
    if (req.query.to) cond.scheduledFor[Op.lte] = String(req.query.to);
  }
  if (req.query.q) {
    const q = `%${String(req.query.q).trim()}%`;
    cond[Op.or] = [
      { bookingCode: { [Op.like]: q } },
      { guestName: { [Op.like]: q } },
      { guestEmail: { [Op.like]: q } },
      { guestPhone: { [Op.like]: q } },
      { paymentId: { [Op.like]: q } },
      { paymentOrderId: { [Op.like]: q } },
    ];
  }
  return cond;
};

// GET /api/admin/bookings
// Query params: status, itemType, q (search booking code/guest), from, to,
// page, limit. Newest first.
const list = asyncHandler(async (req, res) => {
  const base = searchConditions(req);

  // Payment-date range (the Transactions ledger filters on when money moved,
  // not the experience date).
  if (req.query.paidFrom || req.query.paidTo) {
    base.paidAt = base.paidAt || {};
    if (req.query.paidFrom) base.paidAt[Op.gte] = new Date(`${req.query.paidFrom}T00:00:00`);
    if (req.query.paidTo) base.paidAt[Op.lte] = new Date(`${req.query.paidTo}T23:59:59`);
  }
  // Amount range (rupees → paise).
  if (req.query.priceMin || req.query.priceMax) {
    base.totalPaise = {};
    if (req.query.priceMin) base.totalPaise[Op.gte] = Math.round(Number(req.query.priceMin) * 100);
    if (req.query.priceMax) base.totalPaise[Op.lte] = Math.round(Number(req.query.priceMax) * 100);
  }
  // Activity filter — one specific experience.
  if (req.query.itemId) { base.itemType = 'experience'; base.itemId = Number(req.query.itemId); }
  // Category filter — resolve the category's experiences, then scope to them.
  if (req.query.category) {
    const cat = await ExperienceCategory.findOne({ where: { name: String(req.query.category) }, attributes: ['id'] });
    let ids = [];
    if (cat) { const exps = await Experience.findAll({ where: { categoryId: cat.id }, attributes: ['id'] }); ids = exps.map((e) => e.id); }
    base.itemType = 'experience';
    base.itemId = ids.length ? { [Op.in]: ids } : { [Op.in]: [-1] };
  }

  const where = { ...base };
  if (req.query.status) where.status = String(req.query.status);

  // Optional "paid only" mode for the Transactions page on the admin side —
  // saves the client from re-filtering after fetching everything.
  if (req.query.paidOnly === 'true') {
    where.paidAt = { ...(where.paidAt || {}), [Op.ne]: null };
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);

  const { rows, count } = await Booking.findAndCountAll({
    where,
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'phone', 'avatarUrl', 'referralCode', 'isProfileComplete', 'createdAt', 'lastLoginAt'] }],
    order: [['createdAt', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });

  // Aggregated revenue summary — saves the admin dashboard a second roundtrip.
  // Computed over the filtered set so a "this month" filter narrows the totals.
  let totalRevenuePaise = 0;
  let totalRefundPaise = 0;
  let paidCount = 0;
  let cancelledCount = 0;
  // We need an unscoped query to compute these without pagination affecting
  // the totals. Cheaper to re-issue with attributes only.
  const all = await Booking.findAll({ where, attributes: ['status', 'totalPaise', 'refundAmountPaise', 'paidAt'] });
  for (const b of all) {
    if (b.paidAt) {
      totalRevenuePaise += b.totalPaise || 0;
      paidCount += 1;
    }
    if (b.status === 'cancelled' || b.status === 'refunded') cancelledCount += 1;
    totalRefundPaise += b.refundAmountPaise || 0;
  }

  // Pending payment — computed on the same search/date/type filters but WITHOUT
  // the paidOnly gate, so the Transactions page (which always queries
  // paidOnly=true) can still show "how much is pending" alongside its paid ledger.
  // Pending has no payment date, so drop the paidAt window (keep the other
  // filters — search / category / activity / amount).
  const pendingBase = { ...base }; delete pendingBase.paidAt;
  const pendingRows = await Booking.findAll({
    where: { ...pendingBase, status: 'pending_payment' },
    attributes: ['totalPaise'],
  });
  const pendingCount = pendingRows.length;
  const pendingAmountPaise = pendingRows.reduce((s, b) => s + (b.totalPaise || 0), 0);

  return ok(res, {
    bookings: rows.map(adminBookingShape),
    page,
    limit,
    total: count,
    totalPages: Math.max(1, Math.ceil(count / limit)),
    summary: {
      totalRevenue: fromPaise(totalRevenuePaise),
      totalRefund: fromPaise(totalRefundPaise),
      paidCount,
      cancelledCount,
      bookingCount: all.length,
      pendingCount,
      pendingAmount: fromPaise(pendingAmountPaise),
    },
  });
});

// GET /api/admin/bookings/:code
const getByCode = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    where: { bookingCode: String(req.params.code) },
    include: [{ model: User, as: 'user' }],
  });
  if (!booking) return fail(res, 'Booking not found', 404);
  const shaped = adminBookingShape(booking);
  // Rich experience details (about / inclusions / gallery) for the full-page
  // voucher and the supplier split drawer.
  if (booking.itemType === 'experience') {
    try {
      const exp = await Experience.findByPk(booking.itemId);
      if (exp) {
        const j = exp.toJSON();
        const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        shaped.experience = {
          id: j.id,
          about: strip(j.about),
          inclusions: (Array.isArray(j.inclusions) ? j.inclusions : [])
            .map((x) => (typeof x === 'string' ? x : (x && (x.title || x.text)) || '')).map(strip).filter(Boolean),
          gallery: (Array.isArray(j.gallery) ? j.gallery : []).slice(0, 6),
          city: j.city || j.location || null,
          durationLabel: (j.pricing && j.pricing.durationLabel) || (j.data && j.data.durationLabel) || null,
        };
      }
    } catch { /* extras optional */ }
  }
  return ok(res, { booking: shaped });
});

// POST /api/admin/bookings/:code/mark-completed — for past-dated confirmed
// bookings the admin manually flips to completed (e.g. after the guest checks
// out). Not callable on cancelled / refunded rows.
const markCompleted = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({ where: { bookingCode: String(req.params.code) } });
  if (!booking) return fail(res, 'Booking not found', 404);
  if (!['confirmed'].includes(booking.status)) {
    return fail(res, `Cannot mark a ${booking.status} booking as completed`, 400);
  }
  booking.status = 'completed';
  await booking.save();
  return ok(res, { booking: adminBookingShape(booking) }, 'Booking marked completed');
});

// GET /api/admin/bookings/:code/voucher.pdf — the exact guest voucher PDF
// (same one emailed on confirmation), downloadable from the admin bookings UI.
const voucherPdf = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({ where: { bookingCode: String(req.params.code) } });
  if (!booking) return fail(res, 'Booking not found', 404);
  const { buildBookingVoucherPdf } = require('../services/bookingVoucherPdf.service');
  let extras;
  if (booking.itemType === 'experience') {
    try {
      const exp = await Experience.findByPk(booking.itemId);
      if (exp) {
        const j = exp.toJSON();
        const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const incl = (Array.isArray(j.inclusions) ? j.inclusions : [])
          .map((x) => (typeof x === 'string' ? x : (x && (x.title || x.text)) || '')).map(strip).filter(Boolean).slice(0, 8);
        extras = { image: j.mainImage || (Array.isArray(j.gallery) && j.gallery[0]) || null, about: strip(j.about).slice(0, 700), inclusions: incl };
      }
    } catch { /* optional */ }
  }
  const pdf = await buildBookingVoucherPdf(booking, { extras });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="voucher-${booking.bookingCode}.pdf"`);
  return res.send(pdf);
});

module.exports = { list, getByCode, markCompleted, voucherPdf };

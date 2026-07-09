const asyncHandler = require('express-async-handler');
const { Op, fn, col, literal } = require('sequelize');
const { User, Booking, WalletTransaction, Coupon } = require('../models');
const { ok, fail } = require('../utils/response');
const { fromPaise } = require('../services/booking.service');
const { publicBooking } = require('./booking.controller');
const { buildVoucherHtml } = require('../services/bookingEmail.service');
const { send } = require('../pwa/services/mailer');
const { emailShell } = require('../utils/emailLayout');

// Shape returned for the list page — light, only what the table needs. The
// aggregated counts come from a second grouped query (see `list`).
const userListShape = (user, stats) => {
  const json = user.toJSON ? user.toJSON() : user;
  const s = stats || {};
  return {
    id: json.id,
    name: json.name,
    email: json.email,
    phone: json.phone,
    avatarUrl: json.avatarUrl,
    referralCode: json.referralCode,
    isProfileComplete: !!json.isProfileComplete,
    isActive: json.isActive !== false,
    createdAt: json.createdAt,
    lastLoginAt: json.lastLoginAt,
    walletBalance: fromPaise(json.walletBalancePaise || 0),
    bookingCount: Number(s.bookingCount || 0),
    paidBookingCount: Number(s.paidBookingCount || 0),
    totalSpent: fromPaise(Number(s.totalSpentPaise || 0)),
    lastBookingAt: s.lastBookingAt || null,
  };
};

// GET /api/admin/users
// Filters:
//  - q: name / email / phone / bookingCode / paymentId (matches if ANY of these)
//  - from / to: createdAt range (signup date)
//  - hasBookings: 'true' / 'false'
//  - sort: 'newest' | 'oldest' | 'spend' | 'lastActive' | 'bookings'
//  - page, limit
//
// Also returns a summary block with platform-wide totals (filtered set):
// totalUsers, newThisMonth, payingUsers, totalRevenue.
const list = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const hasBookings = req.query.hasBookings;
  const sort = String(req.query.sort || 'newest');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);

  const userWhere = {};
  if (from || to) {
    userWhere.createdAt = {};
    if (from) userWhere.createdAt[Op.gte] = new Date(`${from}T00:00:00.000Z`);
    if (to) userWhere.createdAt[Op.lte] = new Date(`${to}T23:59:59.999Z`);
  }

  // When the operator searches by booking code or payment id, narrow the
  // user list to users that own a matching booking. We resolve the userIds
  // first so the main query stays a plain User.findAndCountAll.
  let userIdFilter = null;
  if (q) {
    const like = `%${q}%`;
    const matchingBookings = await Booking.findAll({
      where: {
        [Op.or]: [
          { bookingCode: { [Op.like]: like } },
          { paymentId: { [Op.like]: like } },
          { paymentOrderId: { [Op.like]: like } },
        ],
      },
      attributes: ['userId'],
      group: ['userId'],
      raw: true,
    });
    const idsFromBookings = matchingBookings.map((b) => b.userId).filter(Boolean);

    // We OR these against the direct user-field search so a name/email/phone
    // match still works even when no booking exists for the query.
    const directOr = [
      { name: { [Op.like]: like } },
      { email: { [Op.like]: like } },
      { phone: { [Op.like]: like } },
      { referralCode: { [Op.like]: like } },
    ];
    if (idsFromBookings.length) directOr.push({ id: { [Op.in]: idsFromBookings } });
    userWhere[Op.and] = [{ [Op.or]: directOr }];
    userIdFilter = idsFromBookings;
  }

  // Sort mapping. Spend/bookings/lastActive need a subquery so we fall back
  // to Sequelize's literal — cleaner than ordering the JS array after fetch
  // when there are many pages of users.
  let order;
  switch (sort) {
    case 'oldest':     order = [['createdAt', 'ASC']]; break;
    case 'spend':      order = [[literal('(SELECT COALESCE(SUM(totalPaise),0) FROM bookings WHERE bookings.userId = User.id AND bookings.paidAt IS NOT NULL)'), 'DESC']]; break;
    case 'bookings':   order = [[literal('(SELECT COUNT(*) FROM bookings WHERE bookings.userId = User.id)'), 'DESC']]; break;
    case 'lastActive': order = [[literal('COALESCE(lastLoginAt, createdAt)'), 'DESC']]; break;
    case 'newest':
    default:           order = [['createdAt', 'DESC']]; break;
  }

  // hasBookings: filter via EXISTS subquery — keeps the count correct.
  if (hasBookings === 'true') {
    userWhere.id = { [Op.in]: literal('(SELECT DISTINCT userId FROM bookings)') };
  } else if (hasBookings === 'false') {
    userWhere.id = { [Op.notIn]: literal('(SELECT DISTINCT userId FROM bookings)') };
  }

  const { rows, count } = await User.findAndCountAll({
    where: userWhere,
    order,
    limit,
    offset: (page - 1) * limit,
  });

  // Booking aggregates per user — one grouped query for the page slice
  // so we never N+1.
  const pageUserIds = rows.map((u) => u.id);
  const aggregates = pageUserIds.length
    ? await Booking.findAll({
        where: { userId: { [Op.in]: pageUserIds } },
        attributes: [
          'userId',
          [fn('COUNT', col('id')), 'bookingCount'],
          [fn('SUM', literal('CASE WHEN paidAt IS NOT NULL THEN 1 ELSE 0 END')), 'paidBookingCount'],
          [fn('SUM', literal('CASE WHEN paidAt IS NOT NULL THEN totalPaise ELSE 0 END')), 'totalSpentPaise'],
          [fn('MAX', col('createdAt')), 'lastBookingAt'],
        ],
        group: ['userId'],
        raw: true,
      })
    : [];
  const aggMap = new Map(aggregates.map((a) => [a.userId, a]));

  // Summary across the FULL filtered set — separate, lightweight query.
  const summaryUsers = await User.findAll({
    where: userWhere,
    attributes: ['id', 'createdAt'],
    raw: true,
  });
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const newThisMonth = summaryUsers.filter((u) => new Date(u.createdAt) >= startOfMonth).length;

  const allUserIds = summaryUsers.map((u) => u.id);
  const revenue = allUserIds.length
    ? await Booking.findOne({
        where: { userId: { [Op.in]: allUserIds }, paidAt: { [Op.ne]: null } },
        attributes: [
          [fn('COUNT', literal('DISTINCT userId')), 'payingUsers'],
          [fn('SUM', col('totalPaise')), 'totalRevenuePaise'],
        ],
        raw: true,
      })
    : { payingUsers: 0, totalRevenuePaise: 0 };

  return ok(res, {
    users: rows.map((u) => userListShape(u, aggMap.get(u.id))),
    page,
    limit,
    total: count,
    totalPages: Math.max(1, Math.ceil(count / limit)),
    summary: {
      totalUsers: count,
      newThisMonth,
      payingUsers: Number(revenue?.payingUsers || 0),
      totalRevenue: fromPaise(Number(revenue?.totalRevenuePaise || 0)),
    },
    // Useful for the UI to render "match via booking" hints when q is set.
    matchedViaBooking: userIdFilter || [],
  });
});

// GET /api/admin/users/:id — full detail bundle.
const getById = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 'Invalid user id', 400);

  const user = await User.findByPk(id, {
    include: [
      { model: User, as: 'referrer', attributes: ['id', 'name', 'email', 'referralCode'] },
    ],
  });
  if (!user) return fail(res, 'User not found', 404);

  const bookings = await Booking.findAll({
    where: { userId: id },
    order: [['createdAt', 'DESC']],
  });

  const wallet = await WalletTransaction.findAll({
    where: { userId: id },
    order: [['createdAt', 'DESC']],
    limit: 100,
  });

  const coupons = await Coupon.findAll({
    where: { userId: id },
    order: [['createdAt', 'DESC']],
    limit: 50,
  });

  const referees = await User.findAll({
    where: { referredByUserId: id },
    attributes: ['id', 'name', 'email', 'createdAt', 'isProfileComplete'],
    order: [['createdAt', 'DESC']],
    limit: 50,
  });

  // Aggregates
  let totalSpentPaise = 0;
  let totalRefundPaise = 0;
  let paidCount = 0;
  let pendingCount = 0;
  let cancelledCount = 0;
  let lastPaidAt = null;
  for (const b of bookings) {
    if (b.paidAt) {
      totalSpentPaise += b.totalPaise || 0;
      paidCount += 1;
      if (!lastPaidAt || new Date(b.paidAt) > new Date(lastPaidAt)) lastPaidAt = b.paidAt;
    }
    if (b.status === 'pending_payment') pendingCount += 1;
    if (b.status === 'cancelled' || b.status === 'refunded') cancelledCount += 1;
    totalRefundPaise += b.refundAmountPaise || 0;
  }

  // Vouchers list — only confirmed/completed bookings get a voucher PDF link.
  const vouchers = bookings
    .filter((b) => ['confirmed', 'completed'].includes(b.status) && b.paidAt)
    .map((b) => ({
      bookingCode: b.bookingCode,
      itemType: b.itemType,
      itemName: b.itemSnapshot?.name || 'Booking',
      scheduledFor: b.scheduledFor,
      total: fromPaise(b.totalPaise || 0),
      voucherUrl: `/api/admin/users/${id}/voucher/${encodeURIComponent(b.bookingCode)}`,
    }));

  const userJson = user.toJSON();

  return ok(res, {
    user: {
      id: userJson.id,
      name: userJson.name,
      email: userJson.email,
      phone: userJson.phone,
      avatarUrl: userJson.avatarUrl,
      gender: userJson.gender,
      dob: userJson.dob,
      addressLine: userJson.addressLine,
      city: userJson.city,
      state: userJson.state,
      country: userJson.country,
      pincode: userJson.pincode,
      referralCode: userJson.referralCode,
      referrer: userJson.referrer || null,
      isProfileComplete: !!userJson.isProfileComplete,
      isActive: userJson.isActive !== false,
      createdAt: userJson.createdAt,
      updatedAt: userJson.updatedAt,
      lastLoginAt: userJson.lastLoginAt,
      walletBalance: fromPaise(userJson.walletBalancePaise || 0),
    },
    stats: {
      bookingCount: bookings.length,
      paidCount,
      pendingCount,
      cancelledCount,
      totalSpent: fromPaise(totalSpentPaise),
      totalRefund: fromPaise(totalRefundPaise),
      walletBalance: fromPaise(userJson.walletBalancePaise || 0),
      lastPaidAt,
      refereeCount: referees.length,
    },
    bookings: bookings.map((b) => {
      const base = publicBooking(b);
      return { ...base, refundAmount: fromPaise(b.refundAmountPaise || 0) };
    }),
    wallet: wallet.map((w) => ({
      id: w.id,
      amount: fromPaise(w.amountPaise),
      balanceAfter: fromPaise(w.balanceAfterPaise),
      type: w.type,
      description: w.description,
      referenceType: w.referenceType,
      referenceId: w.referenceId,
      createdAt: w.createdAt,
    })),
    coupons: coupons.map((c) => ({
      id: c.id,
      code: c.code,
      kind: c.kind,
      value: c.kind === 'flat' ? fromPaise(c.value) : c.value,
      reason: c.reason,
      description: c.description,
      isActive: !!c.isActive,
      expiresAt: c.expiresAt,
      timesUsed: c.timesUsed,
      usageLimit: c.usageLimit,
      isExhausted: c.usageLimit > 0 && c.timesUsed >= c.usageLimit,
      createdAt: c.createdAt,
    })),
    referees: referees.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      createdAt: r.createdAt,
      isProfileComplete: !!r.isProfileComplete,
    })),
    vouchers,
  });
});

// POST /api/admin/users/:id/send-email  { subject, html, text? }
// Free-form admin → user email via Brevo. We log who sent it in the
// subject prefix so the user knows it's a Traveon staff message.
const sendEmail = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 'Invalid user id', 400);

  const subject = String(req.body.subject || '').trim();
  const html = String(req.body.html || '').trim();
  const text = String(req.body.text || '').trim() || undefined;

  if (!subject) return fail(res, 'Subject is required', 400);
  if (!html) return fail(res, 'Body is required', 400);

  const user = await User.findByPk(id);
  if (!user) return fail(res, 'User not found', 404);
  if (!user.email) return fail(res, 'User has no email on file', 400);

  // Wrap in the shared branded shell so the email looks consistent
  // regardless of what the admin pasted into the body editor.
  const wrapped = emailShell({
    preheader: subject,
    bodyHtml: `<div style="color:#101828;font-size:14px;line-height:1.6;">${html}</div>`,
    footerNote: 'Sent by reconnct support · Reply to this email and our team will respond.',
  });

  try {
    await send({ to: user.email, subject, html: wrapped, text });
  } catch (err) {
    console.error('[admin-user] send-email failed:', err.message);
    return fail(res, `Could not send email: ${err.message}`, 502);
  }

  return ok(res, { sentTo: user.email, subject }, 'Email sent');
});

// POST /api/admin/users/:id/toggle-active
const toggleActive = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 'Invalid user id', 400);

  const user = await User.findByPk(id);
  if (!user) return fail(res, 'User not found', 404);

  user.isActive = !user.isActive;
  await user.save();
  return ok(res, { id: user.id, isActive: user.isActive }, user.isActive ? 'User enabled' : 'User disabled');
});

// GET /api/admin/users/:id/voucher/:bookingCode
// Serves the voucher HTML inline so the admin can preview it or use the
// browser's "Save as PDF" / print dialog. Avoids adding a server-side PDF
// renderer dependency just for this one screen.
const getVoucherHtml = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const code = String(req.params.bookingCode || '');
  if (!id || !code) return fail(res, 'Invalid request', 400);

  const booking = await Booking.findOne({ where: { userId: id, bookingCode: code } });
  if (!booking) return fail(res, 'Voucher not found for this user', 404);

  // buildVoucherHtml() returns a complete <!doctype html> document (the same
  // one that's emailed), so the print toolbar is injected into it rather than
  // wrapping it in a second <html>/<body>.
  const printStyle = `<style>
    @media print {
      .no-print { display: none !important; }
      body { background: #fff !important; }
    }
    .toolbar {
      position: sticky; top: 0; z-index: 10;
      background: #101828; color: #fff;
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 20px; font-family: system-ui, sans-serif; font-size: 13px;
    }
    .toolbar button {
      background: #F9B402; border: 0; color: #101010;
      padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: 700;
    }
  </style>`;
  const toolbar = `<div class="toolbar no-print">
    <span>Voucher · ${booking.bookingCode}</span>
    <button onclick="window.print()">Save / Print PDF</button>
  </div>`;

  const fullPage = buildVoucherHtml(booking)
    .replace('</head>', `${printStyle}</head>`)
    .replace(/<body([^>]*)>/, `<body$1>${toolbar}`);

  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(fullPage);
});

module.exports = { list, getById, sendEmail, toggleActive, getVoucherHtml };

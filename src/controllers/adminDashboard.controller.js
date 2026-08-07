const asyncHandler = require('express-async-handler');
const { Op, fn, col } = require('sequelize');
const {
  Booking, Experience, Supplier, User, ExperienceCategory, ExperienceType, Review, Contract,
} = require('../models');
const { ok } = require('../utils/response');

/*
  Admin Home "command center" — one aggregated read that answers: what's
  happening, what needs attention, what to do next. Everything is real, derived
  from bookings + the experiences/suppliers/users/reviews behind them. Profit =
  B2C − B2B (totalPaise − subtotalPaise).
*/
const PAID = ['confirmed', 'completed'];
const toR = (p) => Number(p || 0) / 100;
const r0 = (n) => Math.round(Number(n) || 0);
const pct1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const pctDelta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : (cur ? 100 : null));
const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const dashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  const todayKey = dstr(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const win90 = new Date(now.getTime() - 90 * 86400000);
  const d14 = new Date(now.getTime() - 14 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  // ── Bulk fetches ─────────────────────────────────────────────────────────
  const [bookings, exps, counts, reviewAgg, pendingReviewCount, newReviewCount, contractsPending] = await Promise.all([
    Booking.findAll({
      where: {
        itemType: 'experience',
        [Op.or]: [
          { createdAt: { [Op.gte]: win90 } },
          { paidAt: { [Op.gte]: win90 } },
          { scheduledFor: { [Op.gte]: todayKey } },
        ],
      },
      attributes: ['id', 'bookingCode', 'itemId', 'itemSnapshot', 'userId', 'guestName', 'guestEmail', 'guestCount',
        'status', 'subtotalPaise', 'totalPaise', 'refundAmountPaise', 'refundStatus', 'paymentFailedAt',
        'scheduledFor', 'paidAt', 'createdAt'],
      order: [['createdAt', 'DESC']],
      raw: true,
    }),
    Experience.findAll({
      where: { status: 'published', isActive: true },
      attributes: ['id', 'name', 'city', 'pricing', 'supplierId', 'mainImage'],
      include: [{ model: ExperienceCategory, as: 'category', attributes: ['name'] }],
    }),
    Promise.all([
      Supplier.count({ where: { isActive: true } }),
      User.count(),
      Experience.count(),
      ExperienceCategory.count(),
      Experience.count({ where: { status: 'published', isActive: true } }),
      Experience.count({ where: { status: 'pending_review' } }),
      User.count({ where: { createdAt: { [Op.gte]: monthStart } } }),
    ]),
    Review.findOne({ where: { entityType: 'experience', isApproved: true }, attributes: [[fn('AVG', col('rating')), 'avg'], [fn('COUNT', col('id')), 'n']], raw: true }),
    Review.count({ where: { entityType: 'experience', isApproved: false } }),
    Review.count({ where: { entityType: 'experience', createdAt: { [Op.gte]: monthStart } } }),
    Contract.count({ where: { status: 'draft' } }),
  ]);
  const [supplierCount, userCount, experienceCount, categoryCount, activeExperiences, awaitingApproval, newUsers] = counts;

  const expMap = new Map(exps.map((e) => {
    const j = e.toJSON();
    return [j.id, { name: j.name, city: j.city, capacity: Number(j.pricing?.capacity) || 0, supplierId: j.supplierId, category: (j.category && j.category.name) || null, image: j.mainImage }];
  }));
  const nm = (b) => (expMap.get(b.itemId)?.name) || (b.itemSnapshot && b.itemSnapshot.name) || `Experience #${b.itemId}`;

  const inRange = (b, s, e, field = 'rev') => {
    const d = new Date(field === 'created' ? b.createdAt : (b.paidAt || b.createdAt));
    return d >= s && d <= e;
  };

  // ── KPIs (this month vs last month) ──────────────────────────────────────
  const monthAgg = (s, e) => {
    let revenue = 0; let cost = 0; let paid = 0; let cancelled = 0; let bookingsN = 0; let refunds = 0;
    for (const b of bookings) {
      if (inRange(b, s, e, 'created')) {
        bookingsN += 1;
        if (b.status === 'cancelled') cancelled += 1;
      }
      if (PAID.includes(b.status) && inRange(b, s, e)) { revenue += toR(b.totalPaise); cost += toR(b.subtotalPaise); paid += 1; }
      if (Number(b.refundAmountPaise) > 0 && inRange(b, s, e, 'created')) refunds += toR(b.refundAmountPaise);
    }
    return { revenue: r0(revenue), profit: r0(revenue - cost), paid, cancelled, bookings: bookingsN, refunds: r0(refunds), avg: paid ? r0(revenue / paid) : 0 };
  };
  const lastMonthEnd = new Date(monthStart.getTime() - 1);
  const cur = monthAgg(monthStart, now);
  const prev = monthAgg(lastMonthStart, lastMonthEnd);

  const pendingPaymentsCount = bookings.filter((b) => b.status === 'pending_payment').length;
  const failedPayments = bookings.filter((b) => b.status === 'pending_payment' && b.paymentFailedAt).length;

  const kpis = {
    revenue: { value: cur.revenue, delta: pctDelta(cur.revenue, prev.revenue) },
    bookings: { value: cur.bookings, delta: pctDelta(cur.bookings, prev.bookings), abs: cur.bookings - prev.bookings },
    paid: { value: cur.paid, delta: pctDelta(cur.paid, prev.paid), abs: cur.paid - prev.paid },
    cancellations: { value: cur.cancelled, delta: pctDelta(cur.cancelled, prev.cancelled) },
    pendingPayments: { value: pendingPaymentsCount },
    activeExperiences: { value: activeExperiences },
  };

  // ── Counts strip ─────────────────────────────────────────────────────────
  const totals = { suppliers: supplierCount, users: userCount, experiences: experienceCount, categories: categoryCount, activeExperiences };

  // ── Revenue snapshot (this month + 30-day series + profit/avg/refunds) ───
  const dayMap = new Map();
  for (let i = 29; i >= 0; i -= 1) { const d = new Date(now.getTime() - i * 86400000); dayMap.set(dstr(d), 0); }
  for (const b of bookings) {
    if (!PAID.includes(b.status)) continue;
    const dk = dstr(new Date(b.paidAt || b.createdAt));
    if (dayMap.has(dk)) dayMap.set(dk, dayMap.get(dk) + toR(b.totalPaise));
  }
  const revenueSnapshot = {
    thisMonth: cur.revenue,
    grossProfit: cur.profit,
    avgBooking: cur.avg,
    refunds: cur.refunds,
    series: [...dayMap.entries()].map(([date, revenue]) => ({ date, revenue: r0(revenue) })),
  };

  // ── Booking status overview (90-day window) ─────────────────────────────
  const status = { confirmed: 0, completed: 0, pending: 0, cancelled: 0, refunded: 0 };
  bookings.forEach((b) => {
    if (b.status === 'pending_payment') status.pending += 1;
    else if (status[b.status] != null) status[b.status] += 1;
  });

  // ── Recent bookings ──────────────────────────────────────────────────────
  const recentBookings = bookings.slice(0, 6).map((b) => ({
    code: b.bookingCode, name: nm(b), guest: b.guestName, date: b.scheduledFor,
    participants: b.guestCount, amount: r0(toR(b.totalPaise)), status: b.status,
  }));

  // ── Upcoming (future dated, paid) + capacity ─────────────────────────────
  const upMap = new Map();
  bookings.forEach((b) => {
    if (!PAID.includes(b.status) || !b.scheduledFor || b.scheduledFor < todayKey) return;
    const key = `${b.itemId}|${b.scheduledFor}`;
    const e = upMap.get(key) || { id: b.itemId, name: nm(b), date: b.scheduledFor, booked: 0, capacity: expMap.get(b.itemId)?.capacity || 0 };
    e.booked += Number(b.guestCount || 1); upMap.set(key, e);
  });
  const upcomingAll = [...upMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const upcoming = upcomingAll.slice(0, 8).map((u) => ({ ...u, fillPct: u.capacity ? pct1((u.booked / u.capacity) * 100) : null }));

  const capacity = { almostFull: 0, soldOut: 0, low: 0, items: [] };
  upcomingAll.forEach((u) => {
    if (!u.capacity) return;
    const p = (u.booked / u.capacity) * 100;
    if (p >= 100) { capacity.soldOut += 1; capacity.items.push({ name: u.name, date: u.date, label: 'SOLD OUT', booked: u.booked, capacity: u.capacity }); }
    else if (p >= 80) { capacity.almostFull += 1; capacity.items.push({ name: u.name, date: u.date, label: `${u.booked}/${u.capacity}`, booked: u.booked, capacity: u.capacity }); }
    else if (p < 30) capacity.low += 1;
  });
  capacity.items = capacity.items.slice(0, 6);

  // ── Today's operations ───────────────────────────────────────────────────
  const todayList = bookings.filter((b) => b.scheduledFor === todayKey && PAID.includes(b.status));
  const todayOps = {
    experiencesToday: new Set(todayList.map((b) => b.itemId)).size,
    participantsToday: todayList.reduce((s, b) => s + Number(b.guestCount || 1), 0),
    pendingConfirmations: bookings.filter((b) => b.scheduledFor === todayKey && b.status === 'pending_payment').length,
    pendingPayments: pendingPaymentsCount,
  };

  // ── Pending actions (each links to a module) ─────────────────────────────
  const refundRequests = bookings.filter((b) => ['pending', 'processing'].includes(b.refundStatus)).length;
  const pendingActions = [
    { key: 'confirm', label: 'Bookings awaiting payment', count: pendingPaymentsCount, to: '/admin/bookings' },
    { key: 'refunds', label: 'Refund requests pending', count: refundRequests, to: '/admin/transactions' },
    { key: 'approval', label: 'Experiences awaiting approval', count: awaitingApproval, to: '/admin/experiences/listed' },
    { key: 'failed', label: 'Failed payments', count: failedPayments, to: '/admin/transactions' },
  ].filter((a) => a.count > 0);

  // ── Payments overview (this month) ───────────────────────────────────────
  const payments = {
    collected: cur.revenue,
    pending: r0(bookings.filter((b) => b.status === 'pending_payment').reduce((s, b) => s + toR(b.totalPaise), 0)),
    refunded: cur.refunds,
    failed: failedPayments,
  };

  // ── Top / low performing experiences ─────────────────────────────────────
  const perExp = new Map();
  bookings.forEach((b) => {
    if (!PAID.includes(b.status)) return;
    const e = perExp.get(b.itemId) || { id: b.itemId, name: nm(b), revenue: 0, bookings: 0, last: null };
    e.revenue += toR(b.totalPaise); e.bookings += 1;
    const pd = b.paidAt || b.createdAt; if (!e.last || new Date(pd) > new Date(e.last)) e.last = pd;
    perExp.set(b.itemId, e);
  });
  const topExperiences = [...perExp.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5).map((e) => ({ ...e, revenue: r0(e.revenue) }));

  // Low: published experiences with no paid booking in the last 14 days.
  const paid14 = new Set(bookings.filter((b) => PAID.includes(b.status) && new Date(b.paidAt || b.createdAt) >= d14).map((b) => b.itemId));
  const lowExperiences = exps
    .filter((e) => !paid14.has(e.id))
    .map((e) => { const p = perExp.get(e.id); return { id: e.id, name: e.name, reason: p ? 'No bookings in the last 14 days' : 'No bookings yet' }; })
    .slice(0, 6);

  // ── Supplier overview ────────────────────────────────────────────────────
  const experiencesWithoutSupplier = exps.filter((e) => !e.supplierId).length;
  const supplierOverview = { active: supplierCount, pendingContracts: contractsPending, experiencesWithoutSupplier };

  // ── Customers ────────────────────────────────────────────────────────────
  const userBookings = new Map();
  bookings.forEach((b) => { if (!PAID.includes(b.status)) return; userBookings.set(b.userId, (userBookings.get(b.userId) || 0) + 1); });
  const repeatCustomers = [...userBookings.values()].filter((n) => n > 1).length;
  const activeCustomers = userBookings.size;
  const customers = {
    total: userCount, newThisMonth: newUsers, repeat: repeatCustomers,
    repeatRate: activeCustomers ? pct1((repeatCustomers / activeCustomers) * 100) : 0,
  };

  // ── Reviews ──────────────────────────────────────────────────────────────
  const reviews = {
    avgRating: reviewAgg && reviewAgg.avg ? Math.round(Number(reviewAgg.avg) * 10) / 10 : 0,
    total: reviewAgg ? Number(reviewAgg.n) || 0 : 0,
    newThisMonth: newReviewCount,
    pendingApproval: pendingReviewCount,
  };

  // ── Abandoned / revenue leakage ──────────────────────────────────────────
  const abandonedList = bookings.filter((b) => b.status === 'pending_payment' && new Date(b.createdAt) >= d30);
  const abandoned = { count: abandonedList.length, potentialRevenue: r0(abandonedList.reduce((s, b) => s + toR(b.totalPaise), 0)) };

  // ── Alerts (severity-tagged, real signals only) ──────────────────────────
  const alerts = [];
  if (capacity.soldOut > 0) alerts.push({ severity: 'info', text: `${capacity.soldOut} experience${capacity.soldOut > 1 ? 's are' : ' is'} sold out.` });
  if (capacity.almostFull > 0) alerts.push({ severity: 'attention', text: `${capacity.almostFull} upcoming experience${capacity.almostFull > 1 ? 's are' : ' is'} almost full.` });
  if (failedPayments > 0) alerts.push({ severity: 'critical', text: `${failedPayments} failed payment${failedPayments > 1 ? 's' : ''} need review.` });
  if (refundRequests > 0) alerts.push({ severity: 'attention', text: `${refundRequests} refund request${refundRequests > 1 ? 's' : ''} pending.` });
  if (awaitingApproval > 0) alerts.push({ severity: 'attention', text: `${awaitingApproval} experience${awaitingApproval > 1 ? 's' : ''} awaiting approval.` });
  if (experiencesWithoutSupplier > 0) alerts.push({ severity: 'critical', text: `${experiencesWithoutSupplier} live experience${experiencesWithoutSupplier > 1 ? 's have' : ' has'} no supplier assigned.` });
  if (abandoned.potentialRevenue > 0) alerts.push({ severity: 'info', text: `₹${abandoned.potentialRevenue.toLocaleString('en-IN')} potential revenue in ${abandoned.count} abandoned bookings.` });

  return ok(res, {
    kpis,
    totals,
    revenueSnapshot,
    bookingStatus: status,
    recentBookings,
    upcoming,
    todayOps,
    pendingActions,
    payments,
    topExperiences,
    lowExperiences,
    supplierOverview,
    customers,
    reviews,
    abandoned,
    capacity,
    alerts,
  });
});

module.exports = { dashboard };

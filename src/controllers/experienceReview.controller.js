const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Review, Booking, Experience, User, ExperienceCategory, ExperienceAudience,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const { recomputeStats } = require('./review.controller');
const { isCompleted } = require('../utils/bookingLifecycle');

/*
  Real, user-submitted reviews for a completed Experience booking — distinct
  from the anonymous name/email package/event/hotel review flow in
  review.controller.js. One review per booking; auto-published (no admin
  approval queue), admin can only delete. Shared by the app AND the web user
  dashboard (both hit the exact same endpoints, so behavior always matches).
*/

// A booking is reviewable only once the experience has actually ENDED — not
// the instant it started. End = scheduledAt + duration (see
// utils/bookingLifecycle), which is what stops the rate-and-review popup from
// firing while the guest is still mid-experience.
const isCompletedNow = (booking) => {
  if (booking.status === 'completed') return true;
  if (booking.status !== 'confirmed') return false;
  return isCompleted(booking);
};

// GET /api/bookings/me/pending-review  (authenticateUser)
// The single next completed, unreviewed, non-dismissed experience booking —
// what the app/web home screen auto-popup prompts for. Null if none.
const pendingReview = asyncHandler(async (req, res) => {
  const bookings = await Booking.findAll({
    where: {
      userId: req.user.id,
      itemType: 'experience',
      status: { [Op.in]: ['confirmed', 'completed'] },
      reviewPromptDismissed: { [Op.not]: true },
    },
    order: [['scheduledAt', 'DESC']],
  });
  const due = bookings.find(isCompletedNow);
  if (!due) return ok(res, { booking: null });

  const alreadyReviewed = await Review.findOne({ where: { bookingId: due.id } });
  if (alreadyReviewed) return ok(res, { booking: null });

  const item = due.itemSnapshot || {};
  return ok(res, {
    booking: {
      bookingCode: due.bookingCode,
      itemName: item.name || 'Your experience',
      itemImage: item.image || null,
      itemLocation: item.location || null,
      scheduledFor: due.scheduledAt || due.scheduledFor || null,
    },
  });
});

// POST /api/bookings/:bookingCode/review/dismiss  (authenticateUser)
// "Stop showing this" — the auto-popup won't fire again for this booking, but
// the booking card's manual "Rate" button still works.
const dismissPrompt = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    where: { bookingCode: String(req.params.bookingCode), userId: req.user.id },
  });
  if (!booking) return fail(res, 'Booking not found', 404);
  booking.reviewPromptDismissed = true;
  await booking.save();
  return ok(res, {}, 'Got it — you can still rate this from My Bookings any time.');
});

// POST /api/bookings/:bookingCode/review  (authenticateUser)
//   body: { rating, comment? }
const submitForBooking = asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  const stars = parseInt(rating, 10);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return fail(res, 'Rating must be 1-5', 400);

  const booking = await Booking.findOne({
    where: { bookingCode: String(req.params.bookingCode), userId: req.user.id },
  });
  if (!booking) return fail(res, 'Booking not found', 404);
  if (booking.itemType !== 'experience') return fail(res, 'Only experience bookings can be reviewed', 400);
  if (!isCompletedNow(booking)) return fail(res, 'You can review this once the experience is complete', 400);

  const existing = await Review.findOne({ where: { bookingId: booking.id } });
  if (existing) return fail(res, 'You already reviewed this booking', 400);

  const user = await User.findByPk(req.user.id, { attributes: ['id', 'name', 'email', 'avatarUrl'] });

  const review = await Review.create({
    entityType: 'experience',
    entityId: booking.itemId,
    userId: booking.userId,
    bookingId: booking.id,
    name: user?.name || booking.guestName || 'Guest',
    email: user?.email || null,
    avatarUrl: user?.avatarUrl || null,
    rating: stars,
    comment: comment ? String(comment).trim().slice(0, 2000) : null,
    isApproved: true,
  });

  await recomputeStats('experience', booking.itemId);

  return created(res, { review }, 'Thanks for rating your experience!');
});

// ─────────────────────────── Admin ──────────────────────────────────────

const DATE_PRESETS = {
  today: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; },
  month: () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; },
  '3months': () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d; },
  '6months': () => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d; },
  year: () => { const d = new Date(); d.setMonth(0, 1); d.setHours(0, 0, 0, 0); return d; },
};

// Resolves the shared filter set (category/audience/experience/date range)
// used by both the admin list and the analytics endpoint, into a Review
// `where` clause. Category/audience filters go through Experience's JSON
// array columns, so we resolve matching experience ids first (JS-side
// membership check, same pattern used elsewhere in this codebase for
// categoryIds/audiences arrays).
const resolveFilters = async (query) => {
  const where = { entityType: 'experience' };

  if (query.experienceId) {
    where.entityId = parseInt(query.experienceId, 10);
  } else if (query.categoryId || query.audienceId) {
    const all = await Experience.findAll({ attributes: ['id', 'categoryIds', 'audiences'] });
    const catId = query.categoryId ? parseInt(query.categoryId, 10) : null;
    const audId = query.audienceId ? parseInt(query.audienceId, 10) : null;
    const matchIds = all.filter((e) => {
      const catOk = !catId || (Array.isArray(e.categoryIds) && e.categoryIds.includes(catId));
      const audOk = !audId || (Array.isArray(e.audiences) && e.audiences.includes(audId));
      return catOk && audOk;
    }).map((e) => e.id);
    where.entityId = { [Op.in]: matchIds.length ? matchIds : [-1] };
  }

  if (query.search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.search}%` } },
      { comment: { [Op.like]: `%${query.search}%` } },
    ];
  }

  if (query.from || query.to || (query.dateRange && query.dateRange !== 'custom' && query.dateRange !== 'all')) {
    where.createdAt = {};
    if (query.dateRange && DATE_PRESETS[query.dateRange]) {
      where.createdAt[Op.gte] = DATE_PRESETS[query.dateRange]();
    }
    if (query.from) where.createdAt[Op.gte] = new Date(query.from);
    if (query.to) { const end = new Date(query.to); end.setHours(23, 59, 59, 999); where.createdAt[Op.lte] = end; }
  }

  return where;
};

// GET /api/admin/experience-reviews  (authenticate)
const listAdminExperienceReviews = asyncHandler(async (req, res) => {
  const where = await resolveFilters(req.query);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);

  const { rows, count } = await Review.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });

  const expIds = [...new Set(rows.map((r) => r.entityId))];
  const bookingIds = [...new Set(rows.filter((r) => r.bookingId).map((r) => r.bookingId))];
  const [experiences, bookings] = await Promise.all([
    expIds.length ? Experience.findAll({ where: { id: expIds }, attributes: ['id', 'name', 'city', 'location', 'mainImage'] }) : [],
    bookingIds.length ? Booking.findAll({ where: { id: bookingIds }, attributes: ['id', 'scheduledFor', 'scheduledEndAt', 'specialRequests'] }) : [],
  ]);
  const expById = new Map(experiences.map((e) => [e.id, e]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  const items = rows.map((r) => {
    const j = r.toJSON();
    const exp = expById.get(j.entityId);
    const booking = j.bookingId ? bookingById.get(j.bookingId) : null;
    return {
      id: j.id,
      user: { name: j.name, email: j.email },
      rating: j.rating,
      message: j.comment,
      createdAt: j.createdAt,
      experience: exp ? { id: exp.id, name: exp.name, city: exp.city, location: exp.location, image: exp.mainImage } : null,
      activity: booking ? {
        date: booking.scheduledFor,
        endDate: booking.scheduledEndAt,
        specialRequests: booking.specialRequests,
      } : null,
    };
  });

  return ok(res, {
    items,
    pagination: { page, limit, total: count, pages: Math.max(1, Math.ceil(count / limit)) },
  });
});

// DELETE /api/admin/experience-reviews/:id  (authenticate)
const removeExperienceReview = asyncHandler(async (req, res) => {
  const review = await Review.findOne({ where: { id: req.params.id, entityType: 'experience' } });
  if (!review) return fail(res, 'Review not found', 404);
  const entityId = review.entityId;
  await review.destroy();
  await recomputeStats('experience', entityId);
  return ok(res, {}, 'Review deleted');
});

// ── Trend bucketing (reviews-over-time chart) ──────────────────────────────
// Same day/week/month heuristic as the revenue analytics controller: pick the
// coarseness from how wide the visible range is, so a "Today" filter doesn't
// render 365 empty month buckets and a "This year" filter doesn't render 365
// day buckets.
const pad2 = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const mondayOf = (input) => {
  const x = new Date(input);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};

const buildTrend = (rows, where) => {
  if (!rows.length) return [];
  const times = rows.map((r) => new Date(r.createdAt).getTime());
  const start = where.createdAt?.[Op.gte] ? new Date(where.createdAt[Op.gte]) : new Date(Math.min(...times));
  const end = where.createdAt?.[Op.lte] ? new Date(where.createdAt[Op.lte]) : new Date(Math.max(...times));
  const spanDays = Math.max(1, (end - start) / 86400000);
  const interval = spanDays <= 31 ? 'day' : spanDays <= 120 ? 'week' : 'month';

  const bucketOf = (d) => {
    const dt = new Date(d);
    if (interval === 'month') return monthKey(dt);
    if (interval === 'week') return dstr(mondayOf(dt));
    return dstr(dt);
  };

  const buckets = [];
  if (interval === 'month') {
    let y = start.getFullYear(); let m = start.getMonth();
    const ey = end.getFullYear(); const em = end.getMonth();
    while (y < ey || (y === ey && m <= em)) { buckets.push(`${y}-${pad2(m + 1)}`); m++; if (m > 11) { m = 0; y++; } }
  } else if (interval === 'week') {
    let cur = mondayOf(start); const last = mondayOf(end);
    while (cur <= last) { buckets.push(dstr(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 7); }
  } else {
    let cur = new Date(start); cur.setHours(0, 0, 0, 0);
    const last = new Date(end); last.setHours(0, 0, 0, 0);
    while (cur <= last) { buckets.push(dstr(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 1); }
  }

  const slot = new Map(buckets.map((bk) => [bk, { count: 0, ratingSum: 0 }]));
  rows.forEach((r) => {
    const bk = bucketOf(r.createdAt);
    const s = slot.get(bk);
    if (s) { s.count += 1; s.ratingSum += r.rating || 0; }
  });

  return buckets.map((bk) => {
    const s = slot.get(bk);
    return { bucket: bk, count: s.count, averageRating: s.count ? Number((s.ratingSum / s.count).toFixed(2)) : 0 };
  });
};

// GET /api/admin/experience-reviews/analytics  (authenticate)
const analytics = asyncHandler(async (req, res) => {
  const where = await resolveFilters(req.query);
  const rows = await Review.findAll({ where, attributes: ['rating', 'entityId', 'createdAt'] });

  const totalReviews = rows.length;
  const totalRatingSum = rows.reduce((s, r) => s + (r.rating || 0), 0);
  const averageRating = totalReviews ? totalRatingSum / totalReviews : 0;
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  rows.forEach((r) => { if (distribution[r.rating] != null) distribution[r.rating] += 1; });

  const byExperience = new Map();
  rows.forEach((r) => {
    const cur = byExperience.get(r.entityId) || { count: 0, ratingSum: 0 };
    cur.count += 1; cur.ratingSum += r.rating || 0;
    byExperience.set(r.entityId, cur);
  });
  const ranked = [...byExperience.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  const rankedExperiences = ranked.length
    ? await Experience.findAll({ where: { id: ranked.map(([id]) => id) }, attributes: ['id', 'name'] })
    : [];
  const expNameById = new Map(rankedExperiences.map((e) => [e.id, e.name]));
  const topExperiences = ranked.map(([id, v]) => ({
    id,
    name: expNameById.get(id) || `Experience #${id}`,
    reviewCount: v.count,
    averageRating: Number((v.ratingSum / v.count).toFixed(2)),
  }));

  return ok(res, {
    totalReviews,
    totalRatings: totalReviews,
    averageRating: Number(averageRating.toFixed(2)),
    distribution,
    topExperience: topExperiences[0] || null,
    topExperiences,
    trend: buildTrend(rows, where),
  });
});

// GET /api/admin/experience-reviews/filter-options  (authenticate) — dropdown data
const filterOptions = asyncHandler(async (req, res) => {
  const [categories, audiences, experiences] = await Promise.all([
    ExperienceCategory.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    ExperienceAudience.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    Experience.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }),
  ]);
  return ok(res, { categories, audiences, experiences });
});

module.exports = {
  pendingReview,
  dismissPrompt,
  submitForBooking,
  listAdminExperienceReviews,
  removeExperienceReview,
  analytics,
  filterOptions,
};

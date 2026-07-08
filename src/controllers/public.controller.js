const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, ExperienceAudience, Supplier, User,
} = require('../models');
const { ok, fail } = require('../utils/response');
const { coordsForCity, haversineKm } = require('./geo.controller');
const cashfree = require('../services/cashfree.service');

/*
  PUBLIC (no-auth) surface for the mobile app (reconnct).
  Only published + active experiences are ever exposed here, and the payload
  is flattened into exactly what the app's cards / detail page need so the
  client never has to understand the admin JSON shapes.
*/

const INCLUDE = [
  { model: ExperienceCategory, as: 'category', attributes: ['id', 'name', 'slug', 'icon', 'colorHex'] },
  { model: ExperienceType, as: 'type', attributes: ['id', 'name', 'slug', 'categoryId'] },
  { model: Supplier, as: 'supplier', attributes: ['id', 'companyName', 'supplierName', 'image'] },
];

// pricing.adultPrice is the headline "from" price; the unit comes from priceMethod.
const UNIT = { per_person: 'person', per_day: 'day', days: 'day', per_hours: 'session' };

const fromPrice = (exp) => {
  const p = exp.pricing || {};
  // Headline price is the adult price (matches the card/detail design). Only
  // fall back to the cheapest charged child band if there's no adult price.
  const adult = Number(p.adultPrice);
  if (Number.isFinite(adult) && adult > 0) return adult;
  const bands = (Array.isArray(p.childBands) ? p.childBands : [])
    .map((b) => Number(b && b.price)).filter((n) => Number.isFinite(n) && n > 0);
  return bands.length ? Math.min(...bands) : 0;
};

// Normalised child age-bands for the detail page's pricing block.
const childBands = (exp) => {
  const p = exp.pricing || {};
  if (!p.childrenEnabled || !Array.isArray(p.childBands)) return [];
  return p.childBands.map((b) => ({
    startAge: Number(b.startAge) || 0,
    endAge: Number(b.endAge) || 0,
    charge: b.charge !== false && Number(b.price) > 0,
    price: Number(b.price) || 0,
  }));
};

const durationLabel = (exp) => {
  const p = exp.pricing || {};
  if (exp.priceMethod === 'days' && p.days) return `${p.days} day${p.days > 1 ? 's' : ''}`;
  const d = p.duration || {};
  const h = Number(d.hours) || 0;
  const m = Number(d.minutes) || 0;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h} hr${h > 1 ? 's' : ''}`;
  if (m) return `${m} min`;
  return null;
};

const capacityOf = (exp) => {
  const d = exp.data || {};
  const s = exp.schedule || {};
  const v = d.capacity || d.maxGuests || d.maxParticipants || s.capacity || s.maxParticipants || s.maxGuests;
  return v ? Number(v) : null;
};

const audienceCache = {};
const hydrateAudiences = async (ids) => {
  const want = (Array.isArray(ids) ? ids : []).filter((id) => !(id in audienceCache));
  if (want.length) {
    const rows = await ExperienceAudience.findAll({ where: { id: want } });
    rows.forEach((a) => { audienceCache[a.id] = { id: a.id, name: a.name, slug: a.slug, icon: a.icon }; });
  }
  return (Array.isArray(ids) ? ids : []).map((id) => audienceCache[id]).filter(Boolean);
};

const cardShape = async (exp) => {
  const j = exp.toJSON ? exp.toJSON() : exp;
  return {
    id: j.id,
    slug: j.slug,
    name: j.name,
    mainImage: j.mainImage,
    gallery: Array.isArray(j.gallery) ? j.gallery : [],
    city: j.city,
    location: j.location,
    rating: Number(j.rating) || 0,
    reviewsCount: (j.data && j.data.reviewsCount) || (Array.isArray(j.data && j.data.reviews) ? j.data.reviews.length : 0),
    category: j.category ? { id: j.category.id, name: j.category.name, slug: j.category.slug, colorHex: j.category.colorHex } : null,
    type: j.type ? { id: j.type.id, name: j.type.name, slug: j.type.slug } : null,
    audiences: await hydrateAudiences(j.audiences),
    fromPrice: fromPrice(j),
    currency: j.currency || 'INR',
    priceUnit: UNIT[j.priceMethod] || 'person',
    durationLabel: durationLabel(j),
    capacity: capacityOf(j),
    isFeatured: !!j.isFeatured,
  };
};

const detailShape = async (exp) => {
  const j = exp.toJSON ? exp.toJSON() : exp;
  const base = await cardShape(exp);
  return {
    ...base,
    about: j.about,
    mode: j.mode,
    nearbyLocation: j.nearbyLocation,
    latitude: j.latitude,
    longitude: j.longitude,
    inclusions: Array.isArray(j.inclusions) ? j.inclusions : [],
    facilities: Array.isArray(j.facilities) ? j.facilities : [],
    faqs: Array.isArray(j.faqs) ? j.faqs : [],
    nearbyPlaces: Array.isArray(j.nearbyPlaces) ? j.nearbyPlaces : [],
    videos: Array.isArray(j.videos) ? j.videos : [],
    refundCancellationPolicy: j.refundCancellationPolicy || j.refundPolicy || j.cancellationPolicy || null,
    termsConditions: j.termsConditions || null,
    gstRate: j.gstRate || 0,
    discount: j.discount || null,            // { type:'percentage'|'fixed', value }
    convenienceFee: j.convenienceFee || null, // { type:'free'|'fixed'|'percentage', value }
    priceMethod: j.priceMethod || 'per_person',
    pricing: j.pricing || {},
    childBands: childBands(j),
    schedule: j.schedule || {},
    reviews: Array.isArray(j.data && j.data.reviews) ? j.data.reviews : [],
    // "Hosted by" prefers the real host account (ownerUserId — a "Switch to
    // Host" User) over the admin-assigned Supplier label, since the host is
    // who actually gets the booking email/notification for this listing.
    // Falls back to the Supplier badge when there's no host attached yet.
    supplier: await hostBadge(j),
  };
};

const hostBadge = async (j) => {
  if (j.ownerUserId) {
    const owner = await User.findByPk(j.ownerUserId, { attributes: ['id', 'name', 'company', 'avatarUrl'] });
    if (owner) return { id: owner.id, name: owner.company || owner.name || 'Host', image: owner.avatarUrl || null, verified: true };
  }
  return (j.showSupplierPublic !== false && j.supplier)
    ? { id: j.supplier.id, name: j.supplier.supplierName || j.supplier.companyName, image: j.supplier.image }
    : null;
};

// GET /api/public/experiences
//   ?q= &categoryId= &audienceId= &priceMin= &priceMax= &featured=1 &sort=
const listExperiences = asyncHandler(async (req, res) => {
  const where = { status: 'published', isActive: true };
  if (req.query.categoryId) where.categoryId = parseInt(req.query.categoryId, 10);
  if (req.query.featured === '1' || req.query.featured === 'true') where.isFeatured = true;
  if (req.query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${req.query.q}%` } },
      { city: { [Op.like]: `%${req.query.q}%` } },
      { location: { [Op.like]: `%${req.query.q}%` } },
    ];
  }

  if (req.query.city) where.city = { [Op.like]: `%${req.query.city}%` };

  let items = await Experience.findAll({
    where,
    include: INCLUDE,
    order: [['sortOrder', 'ASC'], ['createdAt', 'DESC']],
  });

  // audienceId filter is a JSON-array membership test → done in JS to stay
  // portable across MySQL versions.
  if (req.query.audienceId) {
    const aid = parseInt(req.query.audienceId, 10);
    items = items.filter((e) => Array.isArray(e.audiences) && e.audiences.includes(aid));
  }

  let cards = await Promise.all(items.map(cardShape));

  const min = req.query.priceMin != null ? Number(req.query.priceMin) : null;
  const max = req.query.priceMax != null ? Number(req.query.priceMax) : null;
  if (min != null) cards = cards.filter((c) => c.fromPrice >= min);
  if (max != null) cards = cards.filter((c) => c.fromPrice <= max);

  // Distance + nearest-first ordering when the app sends the user's coords.
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lon = req.query.lon != null ? Number(req.query.lon) : null;
  if (lat != null && lon != null && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    cards = cards.map((c) => {
      const co = coordsForCity(c.city) || coordsForCity(c.location);
      c.distanceKm = co ? haversineKm(lat, lon, co[0], co[1]) : null;
      return c;
    });
    cards.sort((a, b) => {
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
  }

  return ok(res, { items: cards, count: cards.length });
});

// GET /api/public/experiences/:idOrSlug
const getExperience = asyncHandler(async (req, res) => {
  const key = req.params.idOrSlug;
  const where = /^\d+$/.test(key) ? { id: parseInt(key, 10) } : { slug: key };
  const item = await Experience.findOne({
    where: { ...where, status: 'published', isActive: true },
    include: INCLUDE,
  });
  if (!item) return fail(res, 'Experience not found', 404);
  return ok(res, { item: await detailShape(item) });
});

// GET /api/public/taxonomy  — audiences + categories for the filter UI
const taxonomy = asyncHandler(async (req, res) => {
  const [audiences, categories] = await Promise.all([
    ExperienceAudience.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
    ExperienceCategory.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
  ]);
  return ok(res, {
    audiences: audiences.map((a) => ({ id: a.id, name: a.name, slug: a.slug, icon: a.icon })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon, colorHex: c.colorHex, audiences: Array.isArray(c.audiences) ? c.audiences : [] })),
  });
});

// GET /api/public/types?categoryId=  — types for a category (host onboarding).
// Also accepts ?categoryIds=1,2,3 (comma list) for the union of types across
// every selected category — the multi-select host wizard's taxonomy picker.
const types = asyncHandler(async (req, res) => {
  const where = { isActive: true };
  if (req.query.categoryIds) {
    const ids = String(req.query.categoryIds).split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
    if (ids.length) where.categoryId = { [Op.in]: ids };
  } else if (req.query.categoryId) {
    where.categoryId = Number(req.query.categoryId);
  }
  const rows = await ExperienceType.findAll({
    where,
    order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    attributes: ['id', 'name', 'slug', 'categoryId'],
  });
  return ok(res, { types: rows.map((t) => ({ id: t.id, name: t.name, slug: t.slug, categoryId: t.categoryId })) });
});

// POST /api/public/payments/cashfree-link — create a Cashfree hosted payment
// link for the mobile app to open. Done server-side so the secret stays on the
// backend and the call is reliable (the device only talks to our API).
const cashfreeLink = asyncHandler(async (req, res) => {
  const { amount, name, phone, email, purpose } = req.body || {};
  const amt = Math.round(Number(amount) || 0);
  if (!amt || amt < 1) return fail(res, 'A valid amount is required to start the payment.', 400);
  if (!cashfree.isConfigured()) return fail(res, 'Payments are not configured on the server.', 503);

  const linkId = `rc_${Date.now()}_${Math.floor(1000 + Math.random() * 8999)}`;
  try {
    const { linkUrl, linkId: id } = await cashfree.createPaymentLink({
      linkId, amount: amt, customer: { name, phone, email }, purpose,
    });
    if (!linkUrl) return fail(res, 'Could not create the payment link. Please try again.', 502);
    return ok(res, { linkUrl, linkId: id });
  } catch (e) {
    return fail(res, e.message || 'Could not start the Cashfree payment.', 502);
  }
});

// GET /api/public/cities — distinct cities that have ≥1 published experience.
const cities = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: { status: 'published', isActive: true },
    attributes: ['city'],
  });
  const counts = {};
  rows.forEach((r) => {
    const c = (r.city || '').trim();
    if (c) counts[c] = (counts[c] || 0) + 1;
  });
  const list = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return ok(res, { cities: list });
});

module.exports = { listExperiences, getExperience, taxonomy, types, cities, cashfreeLink };

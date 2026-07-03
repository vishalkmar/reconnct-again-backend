const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType,
} = require('../models');
const { ok, created, fail } = require('../utils/response');

/*
  Host ("Switch to Host") API. A host listing IS an Experience whose
  ownerUserId is the signed-in user. Both the mobile app and the website submit
  the SAME wizard `form` object, which mapFormToExperience() turns into columns.
  Listings are created as status 'draft' + isActive:false so they never leak
  into the public catalog until an admin publishes them (next phase). The
  host-facing state (draft vs submitted-for-review) lives in data.hostStatus.
*/

const uniqueSlug = async (base, ignoreId = null) => {
  const root = slugify(String(base || ''), { lower: true, strict: true }) || `listing-${Date.now()}`;
  let candidate = root;
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Experience.findOne({ where: { slug: candidate, ...(ignoreId ? { id: { [Op.ne]: ignoreId } } : {}) } })) {
    candidate = `${root}-${i++}`;
    if (i > 60) break;
  }
  return candidate;
};

const CATEGORY = { model: ExperienceCategory, as: 'category', attributes: ['id', 'name'] };
const TYPE = { model: ExperienceType, as: 'type', attributes: ['id', 'name'] };

// Wizard form → Experience columns. Tolerant of missing fields (drafts can be
// half-filled). Anything host-specific with no column goes into `data`.
const mapFormToExperience = (form = {}) => {
  const photos = Array.isArray(form.photos) ? form.photos.filter(Boolean) : [];
  const videos = Array.isArray(form.videos) ? form.videos.filter(Boolean) : [];
  const durationLabel = form.durationLabel
    || (form.durationHours || form.durationMinutes
      ? `${form.durationHours || 0}h${form.durationMinutes ? ` ${form.durationMinutes}m` : ''}`
      : '');

  return {
    name: String(form.name || '').trim() || 'Untitled listing',
    audiences: Array.isArray(form.audiences) ? form.audiences : [],
    categoryId: form.categoryId || null,
    typeId: form.typeId || null,
    location: form.location || null,
    city: form.city || null,
    nearbyLocation: form.nearbyLocation || null,
    about: form.about || null,
    mode: ['online', 'offline', 'hybrid'].includes(form.mode) ? form.mode : 'offline',
    mainImage: photos[0] || null,
    gallery: photos,
    videos: videos.map((url) => (typeof url === 'string' ? { type: 'video', url } : url)),
    priceMethod: form.priceMethod || 'per_person',
    pricing: {
      adultPrice: Number(form.adultPrice) || 0,
      childrenEnabled: !!form.childrenEnabled,
      childBands: Array.isArray(form.childBands) ? form.childBands : [],
      capacity: Number(form.capacity) || 0,
      durationHours: Number(form.durationHours) || 0,
      durationMinutes: Number(form.durationMinutes) || 0,
      durationLabel,
    },
    currency: 'INR',
    termsConditions: form.termsConditions || null,
    privacyPolicy: form.privacyPolicy || null,
    refundCancellationPolicy: form.refundCancellationPolicy || null,
    inclusions: Array.isArray(form.inclusions) ? form.inclusions.filter((x) => (typeof x === 'string' ? x.trim() : x)) : [],
    facilities: Array.isArray(form.facilities) ? form.facilities : [],
    nearbyPlaces: Array.isArray(form.nearbyPlaces) ? form.nearbyPlaces : [],
    faqs: Array.isArray(form.faqs) ? form.faqs.filter((f) => f && (f.question || f.answer)) : [],
    schedule: { dateRows: Array.isArray(form.dateRows) ? form.dateRows : [] },
    data: {
      typeName: form.typeName || '',
      durationLabel,
    },
  };
};

// Experience row → the compact "listing card" shape both app + web render.
const toHostListing = (exp) => {
  const j = exp.toJSON ? exp.toJSON() : exp;
  const pricing = j.pricing || {};
  const perDay = j.priceMethod === 'per_day' || j.priceMethod === 'days';
  const hostStatus = (j.data && j.data.hostStatus) || 'draft';
  return {
    id: j.id,
    slug: j.slug,
    status: hostStatus, // draft | pending
    reviewStatus: j.status, // draft | published | archived (admin side)
    title: j.name,
    price: Number(pricing.adultPrice) || 0,
    priceUnit: perDay ? 'day' : 'person',
    durationLabel: pricing.durationLabel || (j.data && j.data.durationLabel) || '',
    image: j.mainImage || (Array.isArray(j.gallery) && j.gallery[0]) || null,
    category: (j.category && j.category.name) || (j.data && j.data.typeName) || (j.type && j.type.name) || '',
    city: j.city || j.location || '',
    rating: Number(j.rating) || 0,
    isPublished: j.status === 'published' && j.isActive,
    bookings: [], // real host-booking feed lands in a later phase
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
};

// Experience row → the wizard form shape (for editing an existing listing).
const toHostForm = (exp) => {
  const j = exp.toJSON ? exp.toJSON() : exp;
  const p = j.pricing || {};
  return {
    id: j.id,
    audiences: j.audiences || [],
    categoryId: j.categoryId || null,
    typeId: j.typeId || null,
    typeName: (j.data && j.data.typeName) || (j.type && j.type.name) || '',
    name: j.name || '',
    location: j.location || '',
    city: j.city || '',
    nearbyLocation: j.nearbyLocation || '',
    durationLabel: p.durationLabel || (j.data && j.data.durationLabel) || '',
    about: j.about || '',
    mode: j.mode || 'offline',
    inclusions: Array.isArray(j.inclusions) && j.inclusions.length ? j.inclusions : [''],
    facilities: j.facilities || [],
    nearbyPlaces: Array.isArray(j.nearbyPlaces) && j.nearbyPlaces.length ? j.nearbyPlaces : [{ name: '', distance: '', unit: 'km' }],
    faqs: j.faqs || [],
    termsConditions: j.termsConditions || '',
    privacyPolicy: j.privacyPolicy || '',
    refundCancellationPolicy: j.refundCancellationPolicy || '',
    priceMethod: j.priceMethod || 'per_person',
    adultPrice: p.adultPrice ? String(p.adultPrice) : '',
    childrenEnabled: !!p.childrenEnabled,
    childBands: p.childBands || [],
    capacity: p.capacity || 8,
    durationHours: p.durationHours || 0,
    durationMinutes: p.durationMinutes || 0,
    dateRows: (j.schedule && j.schedule.dateRows) || [],
    photos: j.gallery || [],
    videos: Array.isArray(j.videos) ? j.videos.map((v) => (typeof v === 'string' ? v : v.url)).filter(Boolean) : [],
  };
};

// GET /api/host/listings — the signed-in host's listings (newest first).
const listMine = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: { ownerUserId: req.user.id },
    include: [CATEGORY, TYPE],
    order: [['createdAt', 'DESC']],
  });
  return ok(res, { listings: rows.map(toHostListing) });
});

// GET /api/host/listings/:id — one of my listings, with its editable form.
const getMine = asyncHandler(async (req, res) => {
  const row = await Experience.findOne({
    where: { id: req.params.id, ownerUserId: req.user.id },
    include: [CATEGORY, TYPE],
  });
  if (!row) return fail(res, 'Listing not found', 404);
  return ok(res, { listing: toHostListing(row), form: toHostForm(row) });
});

// POST /api/host/listings  { form, submit? } — create a draft (or submit for review).
const createMine = asyncHandler(async (req, res) => {
  const form = req.body.form || req.body || {};
  const submit = !!req.body.submit; // true → "Submit for Review"
  const data = mapFormToExperience(form);
  data.ownerUserId = req.user.id;
  data.status = 'draft';    // host listings never auto-publish
  data.isActive = false;    // hidden from the public catalog until approved
  data.data.hostStatus = submit ? 'pending' : 'draft';
  data.slug = await uniqueSlug(form.slug || data.name);
  const row = await Experience.create(data);
  const full = await Experience.findByPk(row.id, { include: [CATEGORY, TYPE] });
  return created(res, { listing: toHostListing(full), form: toHostForm(full) }, submit ? 'Submitted for review' : 'Saved as draft');
});

// PUT /api/host/listings/:id  { form, submit? } — update my listing.
const updateMine = asyncHandler(async (req, res) => {
  const row = await Experience.findOne({ where: { id: req.params.id, ownerUserId: req.user.id } });
  if (!row) return fail(res, 'Listing not found', 404);
  const form = req.body.form || req.body || {};
  const data = mapFormToExperience(form);
  // Keep it host-owned + unpublished; only the admin can flip status/isActive.
  delete data.status;
  delete data.isActive;
  data.data.hostStatus = req.body.submit ? 'pending' : ((row.data && row.data.hostStatus) || 'draft');
  if (form.slug !== undefined && form.slug !== row.slug) data.slug = await uniqueSlug(form.slug, row.id);
  await row.update(data);
  const full = await Experience.findByPk(row.id, { include: [CATEGORY, TYPE] });
  return ok(res, { listing: toHostListing(full), form: toHostForm(full) }, req.body.submit ? 'Submitted for review' : 'Listing updated');
});

// DELETE /api/host/listings/:id
const removeMine = asyncHandler(async (req, res) => {
  const row = await Experience.findOne({ where: { id: req.params.id, ownerUserId: req.user.id } });
  if (!row) return fail(res, 'Listing not found', 404);
  await row.destroy();
  return ok(res, {}, 'Listing deleted');
});

// GET /api/host/summary — dashboard stats (real, derived from the host's data).
const summary = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({ where: { ownerUserId: req.user.id }, attributes: ['id', 'status', 'isActive', 'data'] });
  const listingCount = rows.length;
  const activeCount = rows.filter((r) => r.status === 'published' && r.isActive).length;
  const pendingCount = rows.filter((r) => (r.data && r.data.hostStatus) === 'pending').length;
  const draftCount = rows.filter((r) => ((r.data && r.data.hostStatus) || 'draft') === 'draft').length;
  return ok(res, {
    stats: {
      listingCount,
      activeCount,
      pendingCount,
      draftCount,
      // Real bookings/earnings feed is a later phase — honest zeros for now.
      bookings: 0,
      earnedTotal: 0,
      earnedMonth: 0,
      pendingTotal: 0,
      rating: 0,
    },
  });
});

module.exports = { listMine, getMine, createMine, updateMine, removeMine, summary };

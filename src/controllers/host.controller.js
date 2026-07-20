const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Experience, ExperienceCategory, ExperienceType, Booking,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const { fromPaise } = require('../services/booking.service');
const { ensureAccountManagerAssigned } = require('../services/accountManager.service');
const {
  resetForNewRound, summarize, buildRoundResolutions, logResolutions, sectionChanged,
} = require('../utils/reviewSections');
const reviewNotify = require('../services/reviewNotify.service');
const { validateImagesForSubmit } = require('../utils/experienceValidation');
const { submitterTab } = require('../utils/experienceStatus');

/*
  Once a listing has been handed to Center Ops it stops being the owner's to
  change — exactly like the BD flow, where a submitted experience has no Edit
  action at all and edits only ever happen through the objection-resolution
  round. Without this a supplier could quietly rewrite (or delete) a LIVE
  listing that QCOPS already signed off on, bypassing review entirely.

  Two distinct permissions, deliberately NOT the same flag:

    canWrite — may the API accept an update at all. True for a plain draft AND
      during an open objection round, because the resolve page saves the
      objected sections through this same endpoint.

    canEdit — may the owner open the free-form edit wizard. Draft only. During
      an objection round the ONLY way to change anything is the resolve page,
      section by section with a note per fix — exactly the BD flow, where a
      submitted experience has no Edit action anywhere.
*/
const ownerStage = (row) => {
  const hostStatus = (row.data && row.data.hostStatus) || 'draft';
  // reviewStage is the canonical state; data.hostStatus is a legacy mirror
  // that isn't always cleared when a round ends (a resubmitted BD listing kept
  // 'changes' all the way to QCOPS). Trusting it here showed a phantom
  // "Objections / Resolve" block — and worse, left the listing writable long
  // after content review had passed.
  const inFollowUp = row.reviewStage === 'follow_up';
  const neverSubmitted = row.status === 'draft' && hostStatus === 'draft' && !row.reviewStage;
  return {
    canEdit: neverSubmitted,
    canDelete: neverSubmitted,
    canWrite: neverSubmitted || inFollowUp,
    inFollowUp,
  };
};

// This whole controller is shared by TWO routers: /api/host/* (a signed-in
// User, "Switch to Hosting" — req.user, unchanged) and /api/supplier/* (a
// Supplier's own login, Phase 4 — req.supplier). Every "my listings" query
// resolves ownership from whichever is present instead of assuming req.user.
const ownerWhere = (req) => (req.supplier ? { supplierId: req.supplier.id } : { ownerUserId: req.user.id });
const setOwner = (req, data) => {
  if (req.supplier) data.supplierId = req.supplier.id;
  else data.ownerUserId = req.user.id;
  return data;
};

// YYYY-MM-DD for the app/web listing-bookings cards (they sort/format on this).
const toYMD = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

// Booking status → the host card's upcoming | completed | cancelled buckets.
// Time-based, same rule as experienceReview.controller.js's isCompletedNow —
// prefer the exact scheduledAt timestamp over the date-only scheduledFor so a
// booking scheduled earlier today already reads as completed, not tomorrow.
const hostBookingStatus = (b) => {
  if (b.status === 'cancelled' || b.status === 'refunded') return 'cancelled';
  const endIso = b.scheduledEndAt || b.scheduledAt || b.scheduledFor;
  const past = endIso ? new Date(endIso).getTime() <= Date.now() : false;
  if (b.status === 'completed' || (b.status === 'confirmed' && past)) return 'completed';
  return 'upcoming';
};

// Real bookings for one of the host's experiences (listings). Only rows that
// actually reached payment (or were cancelled) — pending_payment carts are
// noise. Shaped for the ListingBookings card on both app and web.
const bookingsForExperience = async (experienceId) => {
  const rows = await Booking.findAll({
    where: {
      itemType: 'experience',
      itemId: experienceId,
      status: { [Op.in]: ['confirmed', 'completed', 'cancelled', 'refunded'] },
    },
    order: [['scheduledFor', 'DESC'], ['createdAt', 'DESC']],
  });
  return rows.map((r) => {
    const j = r.toJSON ? r.toJSON() : r;
    return {
      id: j.id,
      bookingCode: j.bookingCode,
      guest: j.guestName || 'Guest',
      guests: j.guestCount || 1,
      date: toYMD(j.scheduledFor) || toYMD(j.createdAt) || '1970-01-01',
      // Base amount (subtotal) — the host's payout basis. GST + platform
      // convenience fee are never the host's money, so never show the
      // guest's full total here (must match the voucher email exactly).
      amount: fromPaise(j.subtotalPaise || 0),
      status: hostBookingStatus(j),
    };
  });
};

// GET /api/host/bookings/:id — full detail for a single booking, scoped to
// listings the signed-in host actually owns (404s for anyone else's booking).
const getBooking = asyncHandler(async (req, res) => {
  const booking = await Booking.findByPk(req.params.id);
  if (!booking || booking.itemType !== 'experience') return fail(res, 'Booking not found', 404);
  const exp = await Experience.findOne({ where: { id: booking.itemId, ...ownerWhere(req) } });
  if (!exp) return fail(res, 'Booking not found', 404);

  const j = booking.toJSON();
  const expJ = exp.toJSON ? exp.toJSON() : exp;
  const pricing = expJ.pricing || {};
  return ok(res, {
    booking: {
      id: j.id,
      bookingCode: j.bookingCode,
      status: hostBookingStatus(j),
      guest: { name: j.guestName, email: j.guestEmail, phone: j.guestPhone, count: j.guestCount },
      scheduledFor: j.scheduledFor,
      scheduledEndAt: j.scheduledEndAt,
      units: j.units,
      specialRequests: j.specialRequests,
      currency: j.currency || 'INR',
      baseAmount: fromPaise(j.subtotalPaise || 0),
      unitPrice: fromPaise(j.unitPricePaise || 0),
      paymentId: j.paymentId,
      paymentMethod: j.paymentMethod,
      paidAt: j.paidAt,
      createdAt: j.createdAt,
      // Full itinerary context — same info the guest sees on the detail
      // page — so the host can see exactly what they're hosting, not just
      // who booked and how much.
      item: {
        id: expJ.id,
        name: expJ.name,
        image: expJ.mainImage,
        city: expJ.city,
        location: expJ.location,
        about: expJ.about,
        durationLabel: pricing.durationLabel || (expJ.data && expJ.data.durationLabel) || null,
        inclusions: Array.isArray(expJ.inclusions) ? expJ.inclusions : [],
        faqs: Array.isArray(expJ.faqs) ? expJ.faqs : [],
      },
    },
  });
});

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
    categoryIds: Array.isArray(form.categoryIds) ? form.categoryIds : [],
    typeIds: Array.isArray(form.typeIds) ? form.typeIds : [],
    // Kept in sync as the first selected id — every consumer that still
    // expects a single value (public browse filter, badge displays) keeps
    // working unchanged.
    categoryId: Array.isArray(form.categoryIds) ? (form.categoryIds[0] || null) : null,
    typeId: Array.isArray(form.typeIds) ? (form.typeIds[0] || null) : null,
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
    // Same shape the admin Experience builder uses (ExperienceScheduling.jsx —
    // now shared by the host wizard's own scheduling step too): { dates, slotMode }.
    // One canonical schedule read by the app's booking calendar and the admin
    // panel, regardless of which side created the listing.
    schedule: form.schedule && typeof form.schedule === 'object' ? form.schedule : { dates: [] },
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
    // Center Ops section-review state so the host/supplier card can show
    // objections (with change status + chat history) + suggestion.
    review: (() => {
      const snap = j.reviewSnapshot || null;
      const sm = summarize(j);
      sm.objections = sm.objections.map((o) => ({ ...o, changed: sectionChanged(j, o.key, snap) }));
      return {
        ...sm,
        round: j.reviewRound || 0,
        stage: j.reviewStage || null,
        suggestion: j.reviewSuggestion || '',
        thread: j.reviewThread || {},
      };
    })(),
    reviewNote: j.reviewNote || null,
    reviewSuggestion: j.reviewSuggestion || null,
    // Post-QC changes the owner has been asked to make, and whether they've
    // acknowledged them yet (see upAckMine). Null unless it's in that lane.
    upChanges: j.reviewStage === 'under_progress' && j.qcReview ? {
      changeType: j.qcReview.changeType || null,
      changeDetails: j.qcReview.changeDetails || '',
      deadline: j.qcReview.bdDeadline || null,
      submitterNote: j.qcReview.bdReason || '',
      upState: j.qcReview.upState || null,
      needsAck: j.qcReview.upState === 'bd_approved' && !j.qcReview.supplierAck,
      ack: j.qcReview.supplierAck || null,
    } : null,
    // Which owner-facing tab this belongs in — the SAME derivation the BD's
    // "My Experiences" board uses, so both audiences bucket identically.
    tab: submitterTab(j),
    // Whether the owner may still change it (see ownerStage). Mirrored by the
    // server-side guards on updateMine/removeMine — the UI just hides what
    // would be rejected anyway.
    ...ownerStage(j),
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
    categoryIds: Array.isArray(j.categoryIds) && j.categoryIds.length ? j.categoryIds : (j.categoryId ? [j.categoryId] : []),
    typeIds: Array.isArray(j.typeIds) && j.typeIds.length ? j.typeIds : (j.typeId ? [j.typeId] : []),
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
    schedule: j.schedule && Array.isArray(j.schedule.dates) ? j.schedule : { dates: [] },
    photos: j.gallery || [],
    videos: Array.isArray(j.videos) ? j.videos.map((v) => (typeof v === 'string' ? v : v.url)).filter(Boolean) : [],
  };
};

// GET /api/host/listings — the signed-in host's listings (newest first).
const listMine = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: ownerWhere(req),
    include: [CATEGORY, TYPE],
    order: [['createdAt', 'DESC']],
  });
  return ok(res, { listings: rows.map(toHostListing) });
});

// GET /api/host/listings/:id — one of my listings, with its editable form.
const getMine = asyncHandler(async (req, res) => {
  const row = await Experience.findOne({
    where: { id: req.params.id, ...ownerWhere(req) },
    include: [CATEGORY, TYPE],
  });
  if (!row) return fail(res, 'Listing not found', 404);
  const listing = toHostListing(row);
  listing.bookings = await bookingsForExperience(row.id);
  return ok(res, { listing, form: toHostForm(row) });
});

// POST /api/host/listings  { form, submit? } — create a draft (or submit for review).
const createMine = asyncHandler(async (req, res) => {
  const form = req.body.form || req.body || {};
  const submit = !!req.body.submit; // true → "Submit for Review"
  // Supplier self-serve gate: a supplier can only add a listing once they
  // already have at least one live listing on the platform (the first is
  // onboarded by a BD). Hosts are unaffected.
  if (req.supplier) {
    const liveCount = await Experience.count({ where: { supplierId: req.supplier.id, status: 'published', isActive: true } });
    if (liveCount === 0) {
      return fail(res, 'You can add your own listings only after your first experience is live. Please contact your account manager.', 403);
    }
  }

  const data = setOwner(req, mapFormToExperience(form));
  if (submit) {
    const imgErr = validateImagesForSubmit(data);
    if (imgErr) return fail(res, imgErr, 400);
  }
  data.status = 'draft';    // host listings never auto-publish
  data.isActive = false;    // hidden from the public catalog until approved
  data.data.hostStatus = submit ? 'pending' : 'draft';
  // Signature: this came from the supplier's own dashboard (enables the COPS
  // "list directly / QCOPS optional" path for already-onboarded suppliers).
  if (req.supplier) data.data.submittedVia = 'supplier_portal';
  data.slug = await uniqueSlug(form.slug || data.name);
  const row = await Experience.create(data);
  if (row.supplierId) ensureAccountManagerAssigned(row.supplierId).catch(() => {});
  if (submit) {
    reviewNotify.notifyCopsTeam({ experienceId: row.id, kind: 'submitted', title: `New submission: "${row.name}"`, meta: { experienceName: row.name } }).catch(() => {});
  }
  const full = await Experience.findByPk(row.id, { include: [CATEGORY, TYPE] });
  return created(res, { listing: toHostListing(full), form: toHostForm(full) }, submit ? 'Submitted for review' : 'Saved as draft');
});

// PUT /api/host/listings/:id  { form, submit? } — update my listing.
const updateMine = asyncHandler(async (req, res) => {
  const row = await Experience.findOne({ where: { id: req.params.id, ...ownerWhere(req) } });
  if (!row) return fail(res, 'Listing not found', 404);
  if (!ownerStage(row).canWrite) {
    return fail(res, 'This listing has already been submitted for review and can no longer be edited here. Please contact your account manager.', 403);
  }
  const form = req.body.form || req.body || {};
  const data = mapFormToExperience(form);
  // Keep it host-owned + unpublished; only the admin can flip status/isActive.
  delete data.status;
  delete data.isActive;
  if (req.body.submit) {
    // Validate against the merged result so a partial update still enforces it.
    const merged = { mainImage: 'mainImage' in data ? data.mainImage : row.mainImage, gallery: 'gallery' in data ? data.gallery : row.gallery };
    const imgErr = validateImagesForSubmit(merged);
    if (imgErr) return fail(res, imgErr, 400);
  }
  data.data.hostStatus = req.body.submit ? 'pending' : ((row.data && row.data.hostStatus) || 'draft');
  if (form.slug !== undefined && form.slug !== row.slug) data.slug = await uniqueSlug(form.slug, row.id);

  // "Review again" after a Center Ops follow-up: keep approved sections, drop
  // objected ones back to pending, and mark it as a follow-up round.
  const isReviewAgain = req.body.submit
    && (row.reviewStage === 'follow_up' || (row.reviewSections && Object.keys(row.reviewSections).length));
  if (isReviewAgain) {
    // Require a resolution note per objected section (diff computed vs snapshot
    // AFTER the field edits above are applied — pass the merged next state).
    const nextState = { ...row.toJSON(), ...data };
    const { error: resErr, resolutions } = buildRoundResolutions(nextState, req.body?.resolutions);
    if (resErr) return fail(res, resErr, 400);
    data.reviewResolutions = resolutions;
    data.reviewThread = logResolutions(row.reviewThread, resolutions, row.reviewRound || 0);
    data.reviewSections = resetForNewRound(row.reviewSections);
    data.reviewStage = 'resubmitted';
    data.reviewRound = (row.reviewRound || 0) + 1;
  }
  await row.update(data);

  if (req.body.submit) {
    reviewNotify.notifyCopsTeam({
      experienceId: row.id,
      kind: isReviewAgain ? 'resubmitted' : 'submitted',
      title: isReviewAgain ? `Re-submitted for review: "${row.name}"` : `New submission: "${row.name}"`,
      message: isReviewAgain ? 'The submitter addressed the objections — ready for another look.' : null,
      meta: { experienceName: row.name, round: data.reviewRound || 0 },
    }).catch(() => {});
  }

  const full = await Experience.findByPk(row.id, { include: [CATEGORY, TYPE] });
  return ok(res, { listing: toHostListing(full), form: toHostForm(full) }, req.body.submit ? 'Submitted for review' : 'Listing updated');
});

// DELETE /api/host/listings/:id
/*
  POST /api/supplier/listings/:id/up-ack  { note }
  The supplier's half of the Under Progress handshake. Once the submitter (BD)
  accepts QCOPS's requested changes on their behalf, the supplier is the one
  who actually has to do the work — so a bare "seen" button isn't enough here:
  a written confirmation is REQUIRED, and it's surfaced back on the submitter's
  card so there's a record of what the supplier committed to.
*/
const upAckMine = asyncHandler(async (req, res) => {
  const row = await Experience.findOne({ where: { id: req.params.id, ...ownerWhere(req) } });
  if (!row) return fail(res, 'Listing not found', 404);
  if (row.reviewStage !== 'under_progress') return fail(res, 'There is nothing to acknowledge on this listing', 400);

  const qc = row.qcReview || {};
  if (qc.upState !== 'bd_approved') return fail(res, 'There is nothing to acknowledge yet', 400);
  if (qc.supplierAck) return fail(res, 'You have already acknowledged this', 400);

  const note = String(req.body?.note || '').trim();
  if (!note) return fail(res, 'Please write how you will address the requested changes', 400);

  row.qcReview = { ...qc, supplierAck: { at: new Date().toISOString(), note } };
  await row.save();

  // Straight back to whoever submitted it (the BD) — plus Center Ops's queue.
  await reviewNotify.notifySubmitter(row, {
    kind: 'up_ack_supplier',
    title: `Supplier acknowledged: "${row.name}"`,
    message: note,
    meta: { experienceName: row.name, ackBy: 'supplier', note },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: row.id });

  return ok(res, { listing: toHostListing(row) }, 'Acknowledgement sent');
});

const removeMine = asyncHandler(async (req, res) => {
  const row = await Experience.findOne({ where: { id: req.params.id, ...ownerWhere(req) } });
  if (!row) return fail(res, 'Listing not found', 404);
  if (!ownerStage(row).canDelete) {
    return fail(res, 'This listing is already in the review pipeline and cannot be deleted here. Please contact your account manager to have it delisted.', 403);
  }
  await row.destroy();
  return ok(res, {}, 'Listing deleted');
});

// GET /api/host/summary — dashboard stats (real, derived from the host's data).
const summary = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({
    where: ownerWhere(req),
    attributes: ['id', 'name', 'status', 'isActive', 'data', 'rating'],
  });
  const listingCount = rows.length;
  const activeCount = rows.filter((r) => r.status === 'published' && r.isActive).length;
  const pendingCount = rows.filter((r) => (r.data && r.data.hostStatus) === 'pending').length;
  const draftCount = rows.filter((r) => ((r.data && r.data.hostStatus) || 'draft') === 'draft').length;

  const expIds = rows.map((r) => r.id);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const bookingRows = expIds.length
    ? await Booking.findAll({
        where: {
          itemType: 'experience',
          itemId: { [Op.in]: expIds },
          status: { [Op.in]: ['confirmed', 'completed', 'cancelled', 'refunded'] },
        },
        order: [['createdAt', 'DESC']],
      })
    : [];

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let earnedTotal = 0;
  let earnedMonth = 0;
  let bookingsCount = 0;
  for (const b of bookingRows) {
    const j = b.toJSON();
    if (!['confirmed', 'completed'].includes(j.status)) continue;
    bookingsCount += 1;
    // Base amount only — GST/convenience fee are never the host's earnings.
    const amt = fromPaise(j.subtotalPaise || 0);
    earnedTotal += amt;
    if (j.paidAt && new Date(j.paidAt) >= monthStart) earnedMonth += amt;
  }

  const ratings = rows.map((r) => Number(r.rating) || 0).filter((n) => n > 0);
  const rating = ratings.length ? Math.round((ratings.reduce((s, n) => s + n, 0) / ratings.length) * 10) / 10 : 0;

  // Real "Recent Bookings" feed for the dashboard — was hardcoded demo rows.
  const recentBookings = bookingRows.slice(0, 6).map((b) => {
    const j = b.toJSON();
    return {
      id: j.id,
      guest: j.guestName || 'Guest',
      experience: nameById.get(j.itemId) || 'Experience',
      date: toYMD(j.scheduledFor) || toYMD(j.createdAt) || '1970-01-01',
      amount: fromPaise(j.subtotalPaise || 0),
      status: hostBookingStatus(j),
    };
  });

  // A SUPPLIER may self-add listings only once they already have a live one on
  // the platform (their first is onboarded by a BD). Hosts are unaffected.
  const canAddListing = req.supplier ? activeCount > 0 : true;

  return ok(res, {
    canAddListing,
    stats: {
      listingCount,
      activeCount,
      pendingCount,
      draftCount,
      bookings: bookingsCount,
      earnedTotal,
      earnedMonth,
      pendingTotal: 0,
      rating,
      recentBookings,
    },
  });
});

// GET /api/host/transactions — every real paid booking across all my
// listings, base amount only (never GST/convenience fee — matches the
// voucher email and the dashboard stats exactly). No pending/dummy rows —
// a booking only ever reaches this list once it's actually been paid.
const listTransactions = asyncHandler(async (req, res) => {
  const rows = await Experience.findAll({ where: ownerWhere(req), attributes: ['id', 'name'] });
  const expIds = rows.map((r) => r.id);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const bookingRows = expIds.length
    ? await Booking.findAll({
        where: {
          itemType: 'experience',
          itemId: { [Op.in]: expIds },
          status: { [Op.in]: ['confirmed', 'completed'] },
        },
        order: [['paidAt', 'DESC'], ['createdAt', 'DESC']],
      })
    : [];

  const transactions = bookingRows.map((b) => {
    const j = b.toJSON();
    return {
      id: j.id,
      bookingCode: j.bookingCode,
      guest: j.guestName || 'Guest',
      listingId: j.itemId,
      listingTitle: nameById.get(j.itemId) || 'Experience',
      date: toYMD(j.paidAt) || toYMD(j.createdAt) || '1970-01-01',
      amount: fromPaise(j.subtotalPaise || 0),
      type: 'completed',
    };
  });

  return ok(res, { transactions });
});

module.exports = {
  listMine, getMine, createMine, updateMine, removeMine, summary, getBooking, listTransactions,
  upAckMine,
};

const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Event,
  EventImage,
  EventType,
  EventSlot,
  Location,
  Review,
  sequelize,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const { normalizeGstRate } = require('../config/gst');
const { normalizePriceType } = require('../config/priceType');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

const ensureUniqueSlug = async (base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `event-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (
    await Event.findOne({
      where: { slug: candidate, ...(ignoreId && { id: { [Op.ne]: ignoreId } }) },
    })
  ) {
    candidate = `${slug}-${i++}`;
    if (i > 50) break;
  }
  return candidate;
};

const parseJsonField = (raw, fallback = []) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (Array.isArray(raw) || typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
};

const baseInclude = (publicOnly = false) => [
  { model: EventType, as: 'eventType' },
  { model: Location, as: 'location' },
  { model: EventImage, as: 'gallery' },
  publicOnly
    ? { model: Review, as: 'reviews', where: { isApproved: true }, required: false, separate: true, order: [['createdAt', 'DESC']] }
    : { model: Review, as: 'reviews', separate: true, order: [['createdAt', 'DESC']] },
];

// Slim include for the listing — EventCard only reads columns + the
// eventType and location relations. Gallery and reviews are detail-page
// concerns; skipping them cuts the payload roughly in half.
const listInclude = () => [
  { model: EventType, as: 'eventType' },
  { model: Location, as: 'location' },
];

// ─── Public ───────────────────────────────────────────────────────────────

// GET /api/events
const listPublic = asyncHandler(async (req, res) => {
  const {
    location, eventType, search,
    fromDate, toDate,
    fromTime, toTime,
    minPrice, maxPrice,
    featured,
    sort,
    page = 1, limit = 12,
  } = req.query;

  const where = { isActive: true };
  if (featured === 'true') where.isFeatured = true;

  if (fromDate || toDate) {
    where.eventDate = where.eventDate || {};
    if (fromDate) where.eventDate[Op.gte] = fromDate;
    if (toDate) where.eventDate[Op.lte] = toDate;
  }
  if (fromTime) where.startTime = { ...(where.startTime || {}), [Op.gte]: fromTime };
  if (toTime) where.endTime = { ...(where.endTime || {}), [Op.lte]: toTime };
  if (minPrice) where.price = { ...(where.price || {}), [Op.gte]: parseFloat(minPrice) };
  if (maxPrice) where.price = { ...(where.price || {}), [Op.lte]: parseFloat(maxPrice) };
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
    ];
  }

  const filterInclude = [];
  if (location) filterInclude.push({ model: Location, as: 'location', where: { slug: location }, required: true });
  if (eventType) filterInclude.push({ model: EventType, as: 'eventType', where: { slug: eventType }, required: true });

  let order = [['sortOrder', 'ASC'], ['eventDate', 'ASC'], ['id', 'DESC']];
  if (sort === 'price_asc') order = [['price', 'ASC']];
  else if (sort === 'price_desc') order = [['price', 'DESC']];
  else if (sort === 'date_asc') order = [['eventDate', 'ASC']];
  else if (sort === 'date_desc') order = [['eventDate', 'DESC']];

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const { rows: matches, count } = await Event.findAndCountAll({
    where,
    include: filterInclude,
    attributes: ['id'],
    order,
    limit: parseInt(limit, 10),
    offset,
    distinct: true,
    subQuery: false,
  });
  const ids = matches.map((e) => e.id);
  const rows = ids.length
    ? await Event.findAll({
        where: { id: { [Op.in]: ids } },
        include: listInclude(),
        order,
      })
    : [];

  return ok(res, {
    items: rows,
    pagination: {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      total: count,
      pages: Math.ceil(count / parseInt(limit, 10)),
    },
  });
});

// GET /api/events/price-stats  (public — tiny aggregate, no JOINs)
const priceStats = asyncHandler(async (req, res) => {
  const row = await Event.findOne({
    where: { isActive: true },
    attributes: [
      [sequelize.fn('MIN', sequelize.col('price')), 'min'],
      [sequelize.fn('MAX', sequelize.col('price')), 'max'],
    ],
    raw: true,
  });
  return ok(res, {
    min: Number(row?.min) || 0,
    max: Number(row?.max) || 0,
  });
});

// GET /api/events/:slug
const getBySlug = asyncHandler(async (req, res) => {
  const event = await Event.findOne({
    where: { slug: req.params.slug, isActive: true },
    include: baseInclude(true),
  });
  if (!event) return fail(res, 'Event not found', 404);
  return ok(res, { event });
});

// ─── Admin ────────────────────────────────────────────────────────────────

const listAdmin = asyncHandler(async (req, res) => {
  const items = await Event.findAll({
    include: baseInclude(),
    order: [['sortOrder', 'ASC'], ['eventDate', 'DESC']],
  });
  return ok(res, { items });
});

const getAdminOne = asyncHandler(async (req, res) => {
  const event = await Event.findByPk(req.params.id, { include: baseInclude() });
  if (!event) return fail(res, 'Event not found', 404);
  return ok(res, { event });
});

const createEvent = asyncHandler(async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const body = req.body;
    if (!body.name?.trim()) {
      await t.rollback();
      return fail(res, 'name is required', 400);
    }
    const slug = await ensureUniqueSlug(body.slug || body.name);
    const mainImageFile = req.files?.mainImage?.[0];
    const galleryFiles = req.files?.gallery || [];

    const event = await Event.create({
      name: body.name,
      slug,
      eventTypeId: body.eventTypeId ? parseInt(body.eventTypeId, 10) : null,
      locationId: body.locationId ? parseInt(body.locationId, 10) : null,
      cityName: body.cityName ? String(body.cityName).trim() : null,
      address: body.address ? String(body.address).trim() : null,
      eventDate: body.eventDate || null,
      endDate: body.endDate || null,
      startTime: body.startTime || null,
      endTime: body.endTime || null,
      price: body.price ? parseFloat(body.price) : 0,
      priceOriginal: body.priceOriginal ? parseFloat(body.priceOriginal) : null,
      gstRate: normalizeGstRate(body.gstRate),
      priceType: normalizePriceType(body.priceType) || 'per_person',
      priceLabel: body.priceLabel ? String(body.priceLabel).slice(0, 60) : null,
      currency: body.currency || 'INR',
      minAge: body.minAge ? parseInt(body.minAge, 10) : null,
      maxAge: body.maxAge ? parseInt(body.maxAge, 10) : null,
      mainImage: body.mainImageUrl || (mainImageFile ? buildUrl(mainImageFile) : null),
      mapEmbedHtml: body.mapEmbedHtml || null,
      aboutRich: body.aboutRich || null,
      highlightsRich: body.highlightsRich || null,
      termsConditions: body.termsConditions || null,
      privacyPolicy: body.privacyPolicy || null,
      sports: parseJsonField(body.sports, []),
      isFeatured: body.isFeatured === 'true',
      isActive: body.isActive === 'false' ? false : true,
      isRefundable: body.isRefundable === 'false' ? false : true,
      sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
    }, { transaction: t });

    const galleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...parseJsonField(body.galleryUrls, [])];
    if (galleryAll.length) {
      await EventImage.bulkCreate(
        galleryAll.map((url, i) => ({ eventId: event.id, url, sortOrder: i })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await Event.findByPk(event.id, { include: baseInclude() });
    return created(res, { event: fresh }, 'Event created');
  } catch (err) {
    await t.rollback();
    Object.values(req.files || {}).forEach((arr) =>
      arr.forEach((f) => removeFileIfLocal(buildUrl(f)))
    );
    throw err;
  }
});

const updateEvent = asyncHandler(async (req, res) => {
  const event = await Event.findByPk(req.params.id);
  if (!event) return fail(res, 'Event not found', 404);

  const body = req.body;
  const mainImageFile = req.files?.mainImage?.[0];
  const galleryFiles = req.files?.gallery || [];

  if (body.name !== undefined) event.name = body.name;
  if (body.slug !== undefined && body.slug !== event.slug) {
    event.slug = await ensureUniqueSlug(body.slug, event.id);
  }

  ['startTime', 'endTime', 'currency', 'mapEmbedHtml', 'cityName', 'address',
   'aboutRich', 'highlightsRich', 'termsConditions', 'privacyPolicy',
   'eventDate', 'endDate',
  ].forEach((f) => {
    if (body[f] !== undefined) event[f] = body[f] === '' ? null : body[f];
  });

  ['eventTypeId', 'locationId', 'minAge', 'maxAge', 'sortOrder'].forEach((f) => {
    if (body[f] !== undefined && body[f] !== '') event[f] = parseInt(body[f], 10);
    else if (body[f] === '') event[f] = null;
  });

  if (body.price !== undefined && body.price !== '') event.price = parseFloat(body.price);
  if (body.priceOriginal !== undefined)
    event.priceOriginal = body.priceOriginal === '' ? null : parseFloat(body.priceOriginal);
  if (body.gstRate !== undefined) event.gstRate = normalizeGstRate(body.gstRate);
  if (body.priceType !== undefined) event.priceType = normalizePriceType(body.priceType) || event.priceType;
  if (body.priceLabel !== undefined) event.priceLabel = body.priceLabel ? String(body.priceLabel).slice(0, 60) : null;

  ['isFeatured', 'isActive', 'isRefundable'].forEach((f) => {
    if (body[f] !== undefined) event[f] = body[f] === 'true' || body[f] === true;
  });

  if (body.sports !== undefined) event.sports = parseJsonField(body.sports, []);

  if (body.mainImageUrl !== undefined && body.mainImageUrl !== '') {
    event.mainImage = body.mainImageUrl;
  } else if (mainImageFile) {
    if (event.mainImage) removeFileIfLocal(event.mainImage);
    event.mainImage = buildUrl(mainImageFile);
  }

  await event.save();

  const newGalleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...parseJsonField(body.galleryUrls, [])];
  if (newGalleryAll.length) {
    if (body.replaceGallery === 'true') {
      const existing = await EventImage.findAll({ where: { eventId: event.id } });
      existing.forEach((g) => removeFileIfLocal(g.url));
      await EventImage.destroy({ where: { eventId: event.id } });
    }
    const offset = await EventImage.count({ where: { eventId: event.id } });
    await EventImage.bulkCreate(
      newGalleryAll.map((url, i) => ({ eventId: event.id, url, sortOrder: offset + i })),
    );
  }

  const fresh = await Event.findByPk(event.id, { include: baseInclude() });
  return ok(res, { event: fresh }, 'Event updated');
});

const duplicateEvent = asyncHandler(async (req, res) => {
  const original = await Event.findByPk(req.params.id, { include: baseInclude() });
  if (!original) return fail(res, 'Event not found', 404);

  const t = await sequelize.transaction();
  try {
    const data = original.toJSON();
    const slug = await ensureUniqueSlug(`${data.slug}-copy`);
    ['id', 'slug', 'createdAt', 'updatedAt', 'eventType', 'location', 'gallery'].forEach((k) => delete data[k]);
    const copy = await Event.create({
      ...data,
      name: original.name,
      slug,
      isActive: false,
      isFeatured: false,
    }, { transaction: t });

    if (original.gallery?.length) {
      await EventImage.bulkCreate(
        original.gallery.map((g, i) => ({
          eventId: copy.id, url: g.url, caption: g.caption, sortOrder: i,
        })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await Event.findByPk(copy.id, { include: baseInclude() });
    return created(res, { event: fresh }, 'Event duplicated');
  } catch (err) {
    await t.rollback();
    throw err;
  }
});

const toggle = asyncHandler(async (req, res) => {
  const event = await Event.findByPk(req.params.id);
  if (!event) return fail(res, 'Event not found', 404);
  event.isActive = !event.isActive;
  await event.save();
  return ok(res, { event }, `Event ${event.isActive ? 'published' : 'unpublished'}`);
});

const reorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => Event.update({ sortOrder: idx }, { where: { id } })));
  return ok(res, {}, 'Reordered');
});

const removeEvent = asyncHandler(async (req, res) => {
  const event = await Event.findByPk(req.params.id, {
    include: [{ model: EventImage, as: 'gallery' }],
  });
  if (!event) return fail(res, 'Event not found', 404);
  if (event.mainImage) removeFileIfLocal(event.mainImage);
  event.gallery?.forEach((g) => removeFileIfLocal(g.url));
  await event.destroy();
  return ok(res, {}, 'Event deleted');
});

const removeGalleryImage = asyncHandler(async (req, res) => {
  const img = await EventImage.findOne({
    where: { id: req.params.imageId, eventId: req.params.id },
  });
  if (!img) return fail(res, 'Image not found', 404);
  removeFileIfLocal(img.url);
  await img.destroy();
  return ok(res, {}, 'Image removed');
});

// ─── Slots (for sport-type events) ────────────────────────────────────────

// GET /api/events/:eventId/slots?date=YYYY-MM-DD&sportName=cricket
const listSlots = asyncHandler(async (req, res) => {
  const { date, sportName } = req.query;
  const where = { eventId: req.params.eventId, isActive: true };
  if (date) where.slotDate = date;
  if (sportName) where.sportName = sportName;
  const slots = await EventSlot.findAll({
    where,
    order: [['slotDate', 'ASC'], ['startTime', 'ASC']],
  });
  return ok(res, { items: slots });
});

// POST /api/events/:eventId/slots  (admin — bulk create)
//   body: { slots: [{ slotDate, startTime, endTime, sportName, capacity, price }] }
const createSlots = asyncHandler(async (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  const event = await Event.findByPk(eventId);
  if (!event) return fail(res, 'Event not found', 404);

  const slots = Array.isArray(req.body.slots) ? req.body.slots : [];
  if (!slots.length) return fail(res, 'slots array is required', 400);

  const cleaned = slots.map((s) => ({
    eventId,
    sportName: s.sportName || null,
    slotDate: s.slotDate,
    startTime: s.startTime,
    endTime: s.endTime,
    capacity: s.capacity != null ? parseInt(s.capacity, 10) : 10,
    price: s.price != null && s.price !== '' ? parseFloat(s.price) : null,
    isActive: s.isActive !== false,
  }));
  const created_ = await EventSlot.bulkCreate(cleaned);
  return created(res, { items: created_ }, `${created_.length} slot${created_.length === 1 ? '' : 's'} created`);
});

// PUT /api/events/slots/:slotId
const updateSlot = asyncHandler(async (req, res) => {
  const slot = await EventSlot.findByPk(req.params.slotId);
  if (!slot) return fail(res, 'Slot not found', 404);
  const b = req.body;
  ['slotDate', 'startTime', 'endTime', 'sportName'].forEach((f) => {
    if (b[f] !== undefined) slot[f] = b[f] === '' ? null : b[f];
  });
  if (b.capacity !== undefined && b.capacity !== '') slot.capacity = parseInt(b.capacity, 10);
  if (b.price !== undefined) slot.price = b.price === '' ? null : parseFloat(b.price);
  if (b.isActive !== undefined) slot.isActive = b.isActive === true || b.isActive === 'true';
  await slot.save();
  return ok(res, { slot }, 'Slot updated');
});

// DELETE /api/events/slots/:slotId
const removeSlot = asyncHandler(async (req, res) => {
  const slot = await EventSlot.findByPk(req.params.slotId);
  if (!slot) return fail(res, 'Slot not found', 404);
  await slot.destroy();
  return ok(res, {}, 'Slot removed');
});

// POST /api/events/slots/:slotId/book (public — increment bookedCount)
const bookSlot = asyncHandler(async (req, res) => {
  const slot = await EventSlot.findByPk(req.params.slotId);
  if (!slot) return fail(res, 'Slot not found', 404);
  if (!slot.isActive) return fail(res, 'Slot is closed', 400);
  if (slot.bookedCount >= slot.capacity) return fail(res, 'Slot is fully booked', 400);
  slot.bookedCount = slot.bookedCount + 1;
  await slot.save();
  return ok(res, { slot }, 'Slot booked');
});

module.exports = {
  listPublic, priceStats, getBySlug,
  listAdmin, getAdminOne,
  createEvent, updateEvent, duplicateEvent, toggle, reorder, removeEvent,
  removeGalleryImage,
  listSlots, createSlots, updateSlot, removeSlot, bookSlot,
};

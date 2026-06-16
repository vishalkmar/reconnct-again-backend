const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Hotel,
  HotelImage,
  City,
  Location,
  Facility,
  NearbyPlace,
  Review,
  AvailableRoom,
  sequelize,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

const ensureUniqueSlug = async (base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `hotel-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (
    await Hotel.findOne({
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

const parseIntArray = (raw) => {
  const arr = parseJsonField(raw, []);
  return Array.isArray(arr) ? arr.map((x) => parseInt(x, 10)).filter(Boolean) : [];
};

const baseInclude = (publicOnly = false) => [
  { model: Location, as: 'location' },
  { model: City, as: 'city' },
  { model: Facility, as: 'facilities', through: { attributes: [] } },
  { model: NearbyPlace, as: 'nearbyPlaces', through: { attributes: [] } },
  { model: HotelImage, as: 'gallery' },
  publicOnly
    ? { model: Review, as: 'reviews', where: { isApproved: true }, required: false, separate: true, order: [['createdAt', 'DESC']] }
    : { model: Review, as: 'reviews', separate: true, order: [['createdAt', 'DESC']] },
];

// Cards on the list page only show: primary image (column), name, location,
// city, price, rating + review count (columns), star, a few facility icons.
// They do NOT touch the gallery, individual reviews or nearby-places — so
// we strip those from the listing include. This shaves the listing payload
// dramatically (a populated hotel can have 20+ gallery rows + N reviews).
const listInclude = () => [
  { model: Location, as: 'location' },
  { model: City, as: 'city' },
  { model: Facility, as: 'facilities', through: { attributes: [] } },
];

// ─── Public ───────────────────────────────────────────────────────────────

// GET /api/hotels   (public — listing with filters)
const listPublic = asyncHandler(async (req, res) => {
  const {
    location,        // slug
    city,            // slug
    facility,        // slug (single)
    minPrice,
    maxPrice,
    starRating,      // exact 1–5 or comma-list
    minRating,       // user rating floor
    roomView,        // slug — joins via AvailableRoom in extended impl; ignored here
    search,
    featured,
    sort,
    page = 1,
    limit = 12,
  } = req.query;

  const where = { isActive: true };
  if (minRating) where.rating = { [Op.gte]: parseFloat(minRating) };
  if (starRating) {
    const stars = String(starRating).split(',').map((s) => parseInt(s, 10)).filter(Boolean);
    if (stars.length) where.starRating = { [Op.in]: stars };
  }
  if (featured === 'true') where.isFeatured = true;
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { shortDescription: { [Op.like]: `%${search}%` } },
      { address: { [Op.like]: `%${search}%` } },
    ];
  }

  const filterInclude = [];

  // Price filter is based on the cheapest BOOKABLE room (price > 0) — this is
  // exactly the "From" price shown on the card. A hotel appears when AT LEAST
  // ONE of its active rooms falls inside the range (so a stale hotel.priceFrom
  // can never leak a non-matching hotel into the results).
  if (minPrice || maxPrice) {
    const priceCond = { [Op.gt]: 0 };
    if (minPrice) priceCond[Op.gte] = parseFloat(minPrice);
    if (maxPrice) priceCond[Op.lte] = parseFloat(maxPrice);
    filterInclude.push({
      model: AvailableRoom, as: 'rooms', required: true, attributes: [],
      where: { isActive: true, price: priceCond },
    });
  }

  // Lenient location matching — match via locationId FK OR cityId FK OR address
  // contains (so existing hotels without a locationId still show up).
  if (location) {
    filterInclude.push({ model: Location, as: 'location', where: { slug: location }, required: false });
    if (!city) filterInclude.push({ model: City, as: 'city', where: { slug: location }, required: false });
    where[Op.and] = where[Op.and] || [];
    where[Op.and].push({
      [Op.or]: [
        { '$location.slug$': location },
        { '$city.slug$': location },
        { address: { [Op.like]: `%${location}%` } },
      ],
    });
  }
  if (city) filterInclude.push({ model: City, as: 'city', where: { slug: city }, required: true });

  if (facility) {
    filterInclude.push({
      model: Facility, as: 'facilities', through: { attributes: [] }, where: { slug: facility }, required: true,
    });
  }

  let order = [['sortOrder', 'ASC'], ['id', 'DESC']];
  if (sort === 'price_asc') order = [['priceFrom', 'ASC']];
  else if (sort === 'price_desc') order = [['priceFrom', 'DESC']];
  else if (sort === 'rating') order = [['rating', 'DESC']];
  else if (sort === 'newest') order = [['createdAt', 'DESC']];

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const { rows: matches, count } = await Hotel.findAndCountAll({
    where,
    include: filterInclude,
    attributes: ['id'],
    order,
    limit: parseInt(limit, 10),
    offset,
    distinct: true,
    subQuery: false,
  });
  const ids = matches.map((h) => h.id);
  const rows = ids.length
    ? await Hotel.findAll({
        where: { id: { [Op.in]: ids } },
        include: listInclude(),
        order,
      })
    : [];

  // Replace admin-saved priceFrom with the live cheapest-room price for
  // each card so we never show "INR 0" when the admin forgot to set it.
  if (rows.length) {
    const cheap = await AvailableRoom.findAll({
      // Only rooms with a real price (> 0) count — otherwise a single
      // free/unpriced room would drag the "from" price down to ₹0.
      where: { hotelId: { [Op.in]: ids }, isActive: true, price: { [Op.gt]: 0 } },
      attributes: [
        'hotelId',
        [sequelize.fn('MIN', sequelize.col('price')), 'minPrice'],
      ],
      group: ['hotelId'],
      raw: true,
    });
    const byHotel = Object.fromEntries(
      cheap.map((c) => [c.hotelId, Number(c.minPrice) || 0]),
    );
    for (const h of rows) {
      const live = byHotel[h.id];
      if (live && live > 0) h.setDataValue('priceFrom', live);
    }
  }

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

// GET /api/hotels/price-stats  (public — tiny aggregate, no JOINs)
//
// Returns {min, max} of `priceFrom` across active hotels. Replaces the old
// "fetch limit:200 items just to discover the price ceiling" pattern that
// was costing 7–13 s per page load.
const priceStats = asyncHandler(async (req, res) => {
  const row = await Hotel.findOne({
    where: { isActive: true },
    attributes: [
      [sequelize.fn('MIN', sequelize.col('priceFrom')), 'min'],
      [sequelize.fn('MAX', sequelize.col('priceFrom')), 'max'],
    ],
    raw: true,
  });
  return ok(res, {
    min: Number(row?.min) || 0,
    max: Number(row?.max) || 0,
  });
});

// GET /api/hotels/:slug   (public)
// Pulls the cheapest active room price for a hotel so the "From INR X"
// label on cards / detail pages always reflects a real bookable rate.
// Returns null when there are no active rooms (the caller can decide what
// to show — e.g. "Contact us" or hide the price entirely).
const cheapestRoomPriceFor = async (hotelId) => {
  const row = await AvailableRoom.findOne({
    where: { hotelId, isActive: true, price: { [Op.gt]: 0 } },
    attributes: ['price', 'priceOriginal', 'currency'],
    order: [['price', 'ASC']],
  });
  if (!row) return null;
  const price = Number(row.price) || 0;
  if (price <= 0) return null;
  return {
    price,
    priceOriginal: row.priceOriginal ? Number(row.priceOriginal) : null,
    currency: row.currency || 'INR',
  };
};

const getBySlug = asyncHandler(async (req, res) => {
  const hotel = await Hotel.findOne({
    where: { slug: req.params.slug, isActive: true },
    include: baseInclude(true),
  });
  if (!hotel) return fail(res, 'Hotel not found', 404);
  // Override admin-saved priceFrom with the live cheapest room price so a
  // forgotten or zero admin field never leaks "INR 0" to users.
  const cheapest = await cheapestRoomPriceFor(hotel.id);
  if (cheapest) {
    hotel.setDataValue('priceFrom', cheapest.price);
    if (cheapest.priceOriginal) hotel.setDataValue('priceOriginal', cheapest.priceOriginal);
    if (cheapest.currency) hotel.setDataValue('currency', cheapest.currency);
  }
  return ok(res, { hotel });
});

// ─── Admin ────────────────────────────────────────────────────────────────

// GET /api/hotels/admin/all
const listAdmin = asyncHandler(async (req, res) => {
  const items = await Hotel.findAll({
    include: [
      { model: Location, as: 'location' },
      { model: City, as: 'city' },
      { model: HotelImage, as: 'gallery' },
    ],
    order: [['sortOrder', 'ASC'], ['id', 'DESC']],
  });
  return ok(res, { items });
});

// GET /api/hotels/admin/:id
const getAdminOne = asyncHandler(async (req, res) => {
  const hotel = await Hotel.findByPk(req.params.id, { include: baseInclude() });
  if (!hotel) return fail(res, 'Hotel not found', 404);
  return ok(res, { hotel });
});

// POST /api/hotels   (admin — multipart with primaryImage + gallery[])
const createHotel = asyncHandler(async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const body = req.body;
    if (!body.name?.trim()) {
      await t.rollback();
      return fail(res, 'name is required', 400);
    }

    const slug = await ensureUniqueSlug(body.slug || body.name);

    const primaryImageFile = req.files?.primaryImage?.[0];
    const galleryFiles = req.files?.gallery || [];
    // Instant-upload forms send already-hosted URLs instead of files.
    const galleryUrls = parseJsonField(body.galleryUrls, []);

    const hotel = await Hotel.create(
      {
        name: body.name,
        slug,
        shortDescription: body.shortDescription || null,
        description: body.description || null,
        primaryImage: body.primaryImageUrl || (primaryImageFile ? buildUrl(primaryImageFile) : null),
        videoUrl: body.videoUrl || null,
        videoType: body.videoType || null,
        locationId: body.locationId ? parseInt(body.locationId, 10) : null,
        cityId: body.cityId ? parseInt(body.cityId, 10) : null,
        cityName: body.cityName ? String(body.cityName).trim() : null,
        address: body.address || null,
        mapEmbedHtml: body.mapEmbedHtml || null,
        rating: body.rating ? parseFloat(body.rating) : 0,
        starRating: body.starRating ? parseInt(body.starRating, 10) : null,
        priceFrom: body.priceFrom ? parseFloat(body.priceFrom) : 0,
        priceOriginal: body.priceOriginal ? parseFloat(body.priceOriginal) : null,
        currency: body.currency || 'INR',
        highlightsRich: body.highlightsRich || null,
        inclusionsRich: body.inclusionsRich || null,
        exclusionsRich: body.exclusionsRich || null,
        termsConditions: body.termsConditions || null,
        privacyPolicy: body.privacyPolicy || null,
        faqs: parseJsonField(body.faqs, []),
        isFeatured: body.isFeatured === 'true',
        isActive: body.isActive === 'false' ? false : true,
        metaTitle: body.metaTitle || null,
        metaDescription: body.metaDescription || null,
        sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
      },
      { transaction: t }
    );

    // M2M
    const facilityIds = parseIntArray(body.facilityIds);
    const nearbyPlaceIds = parseIntArray(body.nearbyPlaceIds);
    if (facilityIds.length) await hotel.setFacilities(facilityIds, { transaction: t });
    if (nearbyPlaceIds.length) await hotel.setNearbyPlaces(nearbyPlaceIds, { transaction: t });

    // Gallery — from uploaded files and/or instant-upload URLs.
    const galleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...galleryUrls];
    if (galleryAll.length) {
      await HotelImage.bulkCreate(
        galleryAll.map((url, i) => ({ hotelId: hotel.id, url, sortOrder: i })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await Hotel.findByPk(hotel.id, { include: baseInclude() });
    return created(res, { hotel: fresh }, 'Hotel created');
  } catch (err) {
    await t.rollback();
    Object.values(req.files || {}).forEach((arr) =>
      arr.forEach((f) => removeFileIfLocal(buildUrl(f)))
    );
    throw err;
  }
});

// PUT /api/hotels/:id  (admin)
const updateHotel = asyncHandler(async (req, res) => {
  const hotel = await Hotel.findByPk(req.params.id);
  if (!hotel) return fail(res, 'Hotel not found', 404);

  const body = req.body;
  const primaryImageFile = req.files?.primaryImage?.[0];
  const galleryFiles = req.files?.gallery || [];

  if (body.name !== undefined) hotel.name = body.name;
  if (body.slug !== undefined && body.slug !== hotel.slug) {
    hotel.slug = await ensureUniqueSlug(body.slug, hotel.id);
  }

  const directFields = [
    'shortDescription', 'description', 'videoUrl', 'videoType',
    'address', 'mapEmbedHtml', 'currency', 'cityName',
    'highlightsRich', 'inclusionsRich', 'exclusionsRich',
    'termsConditions', 'privacyPolicy',
    'metaTitle', 'metaDescription',
  ];
  directFields.forEach((f) => {
    if (body[f] !== undefined) hotel[f] = body[f] === '' ? null : body[f];
  });

  const intFields = ['locationId', 'cityId', 'starRating', 'sortOrder'];
  intFields.forEach((f) => {
    if (body[f] !== undefined && body[f] !== '') hotel[f] = parseInt(body[f], 10);
    else if (body[f] === '') hotel[f] = null;
  });

  if (body.rating !== undefined && body.rating !== '') hotel.rating = parseFloat(body.rating);
  if (body.priceFrom !== undefined && body.priceFrom !== '') hotel.priceFrom = parseFloat(body.priceFrom);
  if (body.priceOriginal !== undefined)
    hotel.priceOriginal = body.priceOriginal === '' ? null : parseFloat(body.priceOriginal);

  ['isFeatured', 'isActive'].forEach((f) => {
    if (body[f] !== undefined) hotel[f] = body[f] === 'true' || body[f] === true;
  });

  if (body.faqs !== undefined) hotel.faqs = parseJsonField(body.faqs, []);

  // Instant-upload URL takes precedence; fall back to a multipart file.
  if (body.primaryImageUrl !== undefined && body.primaryImageUrl !== '') {
    hotel.primaryImage = body.primaryImageUrl;
  } else if (primaryImageFile) {
    if (hotel.primaryImage) removeFileIfLocal(hotel.primaryImage);
    hotel.primaryImage = buildUrl(primaryImageFile);
  }

  await hotel.save();

  if (body.facilityIds !== undefined) await hotel.setFacilities(parseIntArray(body.facilityIds));
  if (body.nearbyPlaceIds !== undefined) await hotel.setNearbyPlaces(parseIntArray(body.nearbyPlaceIds));

  const newGalleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...parseJsonField(body.galleryUrls, [])];
  if (newGalleryAll.length) {
    if (body.replaceGallery === 'true') {
      const existing = await HotelImage.findAll({ where: { hotelId: hotel.id } });
      existing.forEach((g) => removeFileIfLocal(g.url));
      await HotelImage.destroy({ where: { hotelId: hotel.id } });
    }
    const offset = await HotelImage.count({ where: { hotelId: hotel.id } });
    await HotelImage.bulkCreate(
      newGalleryAll.map((url, i) => ({ hotelId: hotel.id, url, sortOrder: offset + i })),
    );
  }

  const fresh = await Hotel.findByPk(hotel.id, { include: baseInclude() });
  return ok(res, { hotel: fresh }, 'Hotel updated');
});

// POST /api/hotels/:id/duplicate  (admin)
const duplicateHotel = asyncHandler(async (req, res) => {
  const original = await Hotel.findByPk(req.params.id, { include: baseInclude() });
  if (!original) return fail(res, 'Hotel not found', 404);

  const t = await sequelize.transaction();
  try {
    const data = original.toJSON();
    const slug = await ensureUniqueSlug(`${data.slug}-copy`);

    ['id', 'slug', 'createdAt', 'updatedAt', 'rating', 'reviewCount',
     'location', 'city', 'facilities', 'nearbyPlaces', 'gallery']
      .forEach((k) => delete data[k]);

    const copy = await Hotel.create(
      {
        ...data,
        name: original.name,
        slug,
        isActive: false,
        isFeatured: false,
      },
      { transaction: t }
    );

    const facilityIds = (original.facilities || []).map((f) => f.id);
    const nearbyPlaceIds = (original.nearbyPlaces || []).map((n) => n.id);
    if (facilityIds.length) await copy.setFacilities(facilityIds, { transaction: t });
    if (nearbyPlaceIds.length) await copy.setNearbyPlaces(nearbyPlaceIds, { transaction: t });

    if (original.gallery?.length) {
      await HotelImage.bulkCreate(
        original.gallery.map((g, i) => ({
          hotelId: copy.id,
          url: g.url,
          caption: g.caption,
          sortOrder: i,
        })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await Hotel.findByPk(copy.id, { include: baseInclude() });
    return created(res, { hotel: fresh }, 'Hotel duplicated');
  } catch (err) {
    await t.rollback();
    throw err;
  }
});

// PATCH /api/hotels/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const hotel = await Hotel.findByPk(req.params.id);
  if (!hotel) return fail(res, 'Hotel not found', 404);
  hotel.isActive = !hotel.isActive;
  await hotel.save();
  return ok(res, { hotel }, `Hotel ${hotel.isActive ? 'published' : 'unpublished'}`);
});

// PUT /api/hotels/admin/reorder
const reorderHotels = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => Hotel.update({ sortOrder: idx }, { where: { id } })));
  const items = await Hotel.findAll({ order: [['sortOrder', 'ASC'], ['id', 'DESC']] });
  return ok(res, { items }, 'Reordered');
});

// DELETE /api/hotels/:id
const removeHotel = asyncHandler(async (req, res) => {
  const hotel = await Hotel.findByPk(req.params.id, {
    include: [{ model: HotelImage, as: 'gallery' }],
  });
  if (!hotel) return fail(res, 'Hotel not found', 404);

  if (hotel.primaryImage) removeFileIfLocal(hotel.primaryImage);
  hotel.gallery?.forEach((g) => removeFileIfLocal(g.url));

  await hotel.destroy();
  return ok(res, {}, 'Hotel deleted');
});

// DELETE /api/hotels/:id/gallery/:imageId
const removeGalleryImage = asyncHandler(async (req, res) => {
  const img = await HotelImage.findOne({
    where: { id: req.params.imageId, hotelId: req.params.id },
  });
  if (!img) return fail(res, 'Image not found', 404);
  removeFileIfLocal(img.url);
  await img.destroy();
  return ok(res, {}, 'Image removed');
});

module.exports = {
  listPublic,
  priceStats,
  getBySlug,
  listAdmin,
  getAdminOne,
  createHotel,
  updateHotel,
  duplicateHotel,
  toggle,
  reorderHotels,
  removeHotel,
  removeGalleryImage,
};

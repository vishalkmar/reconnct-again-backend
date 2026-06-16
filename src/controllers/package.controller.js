const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  Package,
  PackageImage,
  Review,
  Trainer,
  City,
  Location,
  Category,
  Problem,
  Activity,
  NearbyPlace,
  Area,
  Culture,
  sequelize,
} = require('../models');
const reviewCtrl = require('./review.controller');
const { ok, created, fail } = require('../utils/response');
const { normalizeGstRate } = require('../config/gst');
const { normalizeTcsRate } = require('../config/tcs');
const { normalizePriceType } = require('../config/priceType');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const removeFileIfLocal = (url) => removeUploadedFile(url);
const buildUrl = (file) => getUploadedUrl(file);

const ensureUniqueSlug = async (base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `package-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (
    await Package.findOne({
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
  { model: City, as: 'city' },
  { model: Location, as: 'location' },
  { model: Category, as: 'categories', through: { attributes: [] } },
  { model: Problem, as: 'problems', through: { attributes: [] } },
  { model: Activity, as: 'activities', through: { attributes: [] } },
  { model: NearbyPlace, as: 'nearbyPlaces', through: { attributes: [] } },
  { model: Area, as: 'areas', through: { attributes: [] } },
  { model: Culture, as: 'cultures', through: { attributes: [] } },
  { model: PackageImage, as: 'gallery' },
  publicOnly
    ? { model: Trainer, as: 'trainers', through: { attributes: [] }, where: { isActive: true }, required: false }
    : { model: Trainer, as: 'trainers', through: { attributes: [] } },
  publicOnly
    ? { model: Review, as: 'reviews', where: { isApproved: true }, required: false, separate: true, order: [['createdAt', 'DESC']] }
    : { model: Review, as: 'reviews', separate: true, order: [['createdAt', 'DESC']] },
];

// GET /api/packages   (public — listing with filters)
const listPublic = asyncHandler(async (req, res) => {
  const {
    city,
    location,           // slug
    category,
    problem,
    activity,
    nearby,             // NearbyPlace slug
    area,               // Area slug
    culture,            // Culture slug
    minPrice,
    maxPrice,
    minDuration,        // days
    maxDuration,
    minNights,
    maxNights,
    minRating,
    startDate,
    endDate,
    month,              // 1..12 — month-only filter
    year,               // YYYY — year-only filter
    search,
    featured,
    popular,
    sort,
    page = 1,
    limit = 12,
  } = req.query;

  const where = { isActive: true };
  if (minPrice) where.priceFrom = { ...(where.priceFrom || {}), [Op.gte]: parseFloat(minPrice) };
  if (maxPrice) where.priceFrom = { ...(where.priceFrom || {}), [Op.lte]: parseFloat(maxPrice) };
  if (minDuration) where.durationDays = { ...(where.durationDays || {}), [Op.gte]: parseInt(minDuration, 10) };
  if (maxDuration) where.durationDays = { ...(where.durationDays || {}), [Op.lte]: parseInt(maxDuration, 10) };
  if (minNights) where.durationNights = { ...(where.durationNights || {}), [Op.gte]: parseInt(minNights, 10) };
  if (maxNights) where.durationNights = { ...(where.durationNights || {}), [Op.lte]: parseInt(maxNights, 10) };
  if (minRating) where.rating = { [Op.gte]: parseFloat(minRating) };
  if (featured === 'true') where.isFeatured = true;
  if (popular === 'true') where.isPopular = true;

  // Date-range filter — overlap logic. A package's [startDate, endDate] should
  // overlap with the requested [startDate, endDate] window. Packages with
  // `availableAllYear === true` always match.
  if (startDate || endDate) {
    where[Op.and] = where[Op.and] || [];
    where[Op.and].push({
      [Op.or]: [
        { availableAllYear: true },
        {
          [Op.and]: [
            startDate ? { [Op.or]: [{ endDate: { [Op.gte]: startDate } }, { endDate: null }] } : {},
            endDate ? { [Op.or]: [{ startDate: { [Op.lte]: endDate } }, { startDate: null }] } : {},
          ],
        },
      ],
    });
  }

  // Month / Year filter — match if package's window includes that month/year,
  // or it's availableAllYear.
  if (month || year) {
    const monthInt = month ? parseInt(month, 10) : null;
    const yearInt = year ? parseInt(year, 10) : null;
    const targetStart = `${yearInt || new Date().getFullYear()}-${String(monthInt || 1).padStart(2, '0')}-01`;
    const targetEnd = monthInt
      ? `${yearInt || new Date().getFullYear()}-${String(monthInt).padStart(2, '0')}-28`
      : `${yearInt || new Date().getFullYear()}-12-31`;
    where[Op.and] = where[Op.and] || [];
    where[Op.and].push({
      [Op.or]: [
        { availableAllYear: true },
        {
          [Op.and]: [
            { [Op.or]: [{ endDate: { [Op.gte]: targetStart } }, { endDate: null }] },
            { [Op.or]: [{ startDate: { [Op.lte]: targetEnd } }, { startDate: null }] },
          ],
        },
      ],
    });
  }

  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { shortDescription: { [Op.like]: `%${search}%` } },
      { locationDetail: { [Op.like]: `%${search}%` } },
    ];
  }

  const filterInclude = [];
  if (city) filterInclude.push({ model: City, as: 'city', where: { slug: city }, required: true });

  // Lenient location matching — a package "in Rishikesh" can match via the new
  // locationId FK, OR via the legacy cityId FK with the same slug, OR via a
  // case-insensitive locationDetail contains. We LEFT-JOIN both relations as
  // non-required and require at least one to match in the WHERE clause.
  if (location) {
    filterInclude.push({ model: Location, as: 'location', where: { slug: location }, required: false });
    if (!city) filterInclude.push({ model: City, as: 'city', where: { slug: location }, required: false });
    where[Op.and] = where[Op.and] || [];
    where[Op.and].push({
      [Op.or]: [
        { '$location.slug$': location },
        { '$city.slug$': location },
        { locationDetail: { [Op.like]: `%${location}%` } },
      ],
    });
  }
  if (category) {
    filterInclude.push({
      model: Category, as: 'categories', through: { attributes: [] }, where: { slug: category }, required: true,
    });
  }
  if (problem) {
    filterInclude.push({
      model: Problem, as: 'problems', through: { attributes: [] }, where: { slug: problem }, required: true,
    });
  }
  if (activity) {
    filterInclude.push({
      model: Activity, as: 'activities', through: { attributes: [] }, where: { slug: activity }, required: true,
    });
  }
  if (nearby) {
    filterInclude.push({
      model: NearbyPlace, as: 'nearbyPlaces', through: { attributes: [] }, where: { slug: nearby }, required: true,
    });
  }
  if (area) {
    filterInclude.push({
      model: Area, as: 'areas', through: { attributes: [] }, where: { slug: area }, required: true,
    });
  }
  if (culture) {
    filterInclude.push({
      model: Culture, as: 'cultures', through: { attributes: [] }, where: { slug: culture }, required: true,
    });
  }

  // List payload is intentionally slim. PackageCard only touches: location,
  // city, categories (for chips), activities (for chips), plus columns
  // (primaryImage, priceFrom, rating, reviewCount, …). Everything else —
  // problems, nearby places, areas, cultures, gallery rows, reviews — is
  // fetched on the detail page only. Cuts the JOIN graph from 7+ many-to-
  // many tables down to 2, which is where most of the 13 s came from.
  const include = [
    { model: City, as: 'city' },
    { model: Location, as: 'location' },
    { model: Category, as: 'categories', through: { attributes: [] } },
    { model: Activity, as: 'activities', through: { attributes: [] } },
  ];

  let order = [['sortOrder', 'ASC'], ['id', 'DESC']];
  if (sort === 'price_asc') order = [['priceFrom', 'ASC']];
  else if (sort === 'price_desc') order = [['priceFrom', 'DESC']];
  else if (sort === 'rating') order = [['rating', 'DESC']];
  else if (sort === 'newest') order = [['createdAt', 'DESC']];

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const { rows: matches, count } = await Package.findAndCountAll({
    where,
    include: filterInclude,
    attributes: ['id'],
    order,
    limit: parseInt(limit, 10),
    offset,
    distinct: true,
    subQuery: false,
  });
  const ids = matches.map((p) => p.id);
  const rows = ids.length
    ? await Package.findAll({
        where: { id: { [Op.in]: ids } },
        include,
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

// GET /api/packages/price-stats  (public — tiny aggregate, no JOINs)
const priceStats = asyncHandler(async (req, res) => {
  const row = await Package.findOne({
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

// GET /api/packages/:slug  (public — by slug)
const getBySlug = asyncHandler(async (req, res) => {
  const pkg = await Package.findOne({
    where: { slug: req.params.slug, isActive: true },
    include: baseInclude(true),
  });
  if (!pkg) return fail(res, 'Package not found', 404);

  // bump interested counter softly when fetched (could be moved to a separate endpoint)
  return ok(res, { package: pkg });
});

// GET /api/packages/admin/all  (admin — full list)
const listAdmin = asyncHandler(async (req, res) => {
  const items = await Package.findAll({
    include: [
      { model: City, as: 'city' },
      { model: Category, as: 'categories', through: { attributes: [] } },
      { model: PackageImage, as: 'gallery' },
    ],
    order: [['sortOrder', 'ASC'], ['id', 'DESC']],
  });
  return ok(res, { items });
});

// GET /api/packages/admin/:id
const getAdminOne = asyncHandler(async (req, res) => {
  const pkg = await Package.findByPk(req.params.id, { include: baseInclude(false) });
  if (!pkg) return fail(res, 'Package not found', 404);
  return ok(res, { package: pkg });
});

// POST /api/packages   (admin — multipart with primaryImage + gallery[] + hostImage)
const createPackage = asyncHandler(async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const body = req.body;
    if (!body.name?.trim()) {
      await t.rollback();
      return fail(res, 'name is required', 400);
    }

    const slug = await ensureUniqueSlug(body.slug || body.name);

    const primaryImageFile = req.files?.primaryImage?.[0];
    const hostImageFile = req.files?.hostImage?.[0];
    const galleryFiles = req.files?.gallery || [];

    const pkg = await Package.create(
      {
        name: body.name,
        slug,
        shortDescription: body.shortDescription || null,
        description: body.description || null,
        primaryImage: body.primaryImageUrl || (primaryImageFile ? buildUrl(primaryImageFile) : null),
        videoUrl: body.videoUrl || null,
        cityId: body.cityId ? parseInt(body.cityId, 10) : null,
        cityName: body.cityName ? String(body.cityName).trim() : null,
        locationId: body.locationId ? parseInt(body.locationId, 10) : null,
        locationDetail: body.locationDetail || null,
        durationDays: body.durationDays ? parseInt(body.durationDays, 10) : 1,
        durationNights: body.durationNights ? parseInt(body.durationNights, 10) : 0,
        timing: body.timing || null,
        availableAllYear: body.availableAllYear === 'false' ? false : true,
        startDate: body.startDate || null,
        endDate: body.endDate || null,
        minGroupSize: body.minGroupSize ? parseInt(body.minGroupSize, 10) : 1,
        maxGroupSize: body.maxGroupSize ? parseInt(body.maxGroupSize, 10) : 30,
        priceFrom: body.priceFrom ? parseFloat(body.priceFrom) : 0,
        priceOriginal: body.priceOriginal ? parseFloat(body.priceOriginal) : null,
        gstRate: normalizeGstRate(body.gstRate),
        tcsRate: normalizeTcsRate(body.tcsRate),
        priceType: normalizePriceType(body.priceType) || 'per_person',
        priceLabel: body.priceLabel ? String(body.priceLabel).slice(0, 60) : null,
        currency: body.currency || 'INR',
        freeCancellation: body.freeCancellation === 'false' ? false : true,
        isGoldHost: body.isGoldHost === 'true',
        isFeatured: body.isFeatured === 'true',
        isPopular: body.isPopular === 'true',
        isActive: body.isActive === 'false' ? false : true,
        richContent: body.richContent || null,
        highlightsRich: body.highlightsRich || null,
        inclusionsRich: body.inclusionsRich || null,
        exclusionsRich: body.exclusionsRich || null,
        termsConditions: body.termsConditions || null,
        refundsPolicy: body.refundsPolicy || null,
        cancellationPolicy: body.cancellationPolicy || null,
        bookingTerms: body.bookingTerms || null,
        retreatExperience: body.retreatExperience || null,
        whatMakesSpecial: body.whatMakesSpecial || null,
        fullProgramTiming: body.fullProgramTiming || null,
        food: body.food || null,
        benefits: body.benefits || null,
        meals: parseJsonField(body.meals, []),
        diets: parseJsonField(body.diets, []),
        facilities: parseJsonField(body.facilities, []),
        highlights: parseJsonField(body.highlights, []),
        includes: parseJsonField(body.includes, []),
        excludes: parseJsonField(body.excludes, []),
        itinerary: parseJsonField(body.itinerary, []),
        faqs: parseJsonField(body.faqs, []),
        hostName: body.hostName || null,
        hostBio: body.hostBio || null,
        hostImage: body.hostImageUrl || (hostImageFile ? buildUrl(hostImageFile) : null),
        // PWA Check-Availability assignment
        pwaOwnerId:       body.pwaOwnerId ? parseInt(body.pwaOwnerId, 10) : null,
        pwaSalespersonId: body.pwaSalespersonId ? parseInt(body.pwaSalespersonId, 10) : null,
        ownerContactName:  body.ownerContactName  || null,
        ownerContactEmail: body.ownerContactEmail || null,
        ownerContactPhone: body.ownerContactPhone || null,
        metaTitle: body.metaTitle || null,
        metaDescription: body.metaDescription || null,
        sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
      },
      { transaction: t }
    );

    // M2M
    const categoryIds = parseIntArray(body.categoryIds);
    const problemIds = parseIntArray(body.problemIds);
    const activityIds = parseIntArray(body.activityIds);
    const nearbyPlaceIds = parseIntArray(body.nearbyPlaceIds);
    const areaIds = parseIntArray(body.areaIds);
    const cultureIds = parseIntArray(body.cultureIds);
    const trainerIds = parseIntArray(body.trainerIds);
    if (categoryIds.length) await pkg.setCategories(categoryIds, { transaction: t });
    if (problemIds.length) await pkg.setProblems(problemIds, { transaction: t });
    if (activityIds.length) await pkg.setActivities(activityIds, { transaction: t });
    if (nearbyPlaceIds.length) await pkg.setNearbyPlaces(nearbyPlaceIds, { transaction: t });
    if (areaIds.length) await pkg.setAreas(areaIds, { transaction: t });
    if (cultureIds.length) await pkg.setCultures(cultureIds, { transaction: t });
    if (trainerIds.length) await pkg.setTrainers(trainerIds, { transaction: t });

    // Gallery
    const galleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...parseJsonField(body.galleryUrls, [])];
    if (galleryAll.length) {
      await PackageImage.bulkCreate(
        galleryAll.map((url, i) => ({ packageId: pkg.id, url, sortOrder: i })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await Package.findByPk(pkg.id, { include: baseInclude(false) });
    return created(res, { package: fresh }, 'Package created');
  } catch (err) {
    await t.rollback();
    // Clean up uploaded files on failure
    Object.values(req.files || {}).forEach((arr) =>
      arr.forEach((f) => removeFileIfLocal(buildUrl(f)))
    );
    throw err;
  }
});

// PUT /api/packages/:id  (admin)
const updatePackage = asyncHandler(async (req, res) => {
  const pkg = await Package.findByPk(req.params.id);
  if (!pkg) return fail(res, 'Package not found', 404);

  const body = req.body;
  const primaryImageFile = req.files?.primaryImage?.[0];
  const hostImageFile = req.files?.hostImage?.[0];
  const galleryFiles = req.files?.gallery || [];

  if (body.name !== undefined) pkg.name = body.name;
  if (body.slug !== undefined && body.slug !== pkg.slug) {
    pkg.slug = await ensureUniqueSlug(body.slug, pkg.id);
  }
  const directFields = [
    'shortDescription', 'description', 'videoUrl', 'locationDetail', 'timing', 'cityName',
    'startDate', 'endDate', 'currency', 'hostName', 'hostBio',
    'metaTitle', 'metaDescription',
    'richContent', 'highlightsRich', 'inclusionsRich', 'exclusionsRich',
    'termsConditions', 'refundsPolicy', 'cancellationPolicy', 'bookingTerms',
    'retreatExperience', 'whatMakesSpecial', 'fullProgramTiming',
    'food', 'benefits',
    'ownerContactName', 'ownerContactEmail', 'ownerContactPhone',
  ];
  directFields.forEach((f) => {
    if (body[f] !== undefined) pkg[f] = body[f] === '' ? null : body[f];
  });

  const intFields = ['cityId', 'locationId', 'durationDays', 'durationNights', 'minGroupSize', 'maxGroupSize', 'sortOrder'];
  intFields.forEach((f) => {
    if (body[f] !== undefined && body[f] !== '') pkg[f] = parseInt(body[f], 10);
  });

  // Nullable FK fields — allow explicit clear via empty string.
  ['pwaOwnerId', 'pwaSalespersonId'].forEach((f) => {
    if (body[f] !== undefined) {
      pkg[f] = body[f] === '' || body[f] === null ? null : parseInt(body[f], 10);
    }
  });

  if (body.priceFrom !== undefined && body.priceFrom !== '') pkg.priceFrom = parseFloat(body.priceFrom);
  if (body.priceOriginal !== undefined)
    pkg.priceOriginal = body.priceOriginal === '' ? null : parseFloat(body.priceOriginal);
  if (body.gstRate !== undefined) pkg.gstRate = normalizeGstRate(body.gstRate);
  if (body.tcsRate !== undefined) pkg.tcsRate = normalizeTcsRate(body.tcsRate);
  if (body.priceType !== undefined) pkg.priceType = normalizePriceType(body.priceType) || pkg.priceType;
  if (body.priceLabel !== undefined) pkg.priceLabel = body.priceLabel ? String(body.priceLabel).slice(0, 60) : null;

  const boolFields = ['availableAllYear', 'freeCancellation', 'isGoldHost', 'isFeatured', 'isPopular', 'isActive'];
  boolFields.forEach((f) => {
    if (body[f] !== undefined) pkg[f] = body[f] === 'true' || body[f] === true;
  });

  ['highlights', 'includes', 'excludes', 'itinerary', 'faqs', 'meals', 'diets', 'facilities'].forEach((f) => {
    if (body[f] !== undefined) pkg[f] = parseJsonField(body[f], []);
  });

  if (body.primaryImageUrl !== undefined && body.primaryImageUrl !== '') {
    pkg.primaryImage = body.primaryImageUrl;
  } else if (primaryImageFile) {
    if (pkg.primaryImage) removeFileIfLocal(pkg.primaryImage);
    pkg.primaryImage = buildUrl(primaryImageFile);
  }
  if (body.hostImageUrl !== undefined && body.hostImageUrl !== '') {
    pkg.hostImage = body.hostImageUrl;
  } else if (hostImageFile) {
    if (pkg.hostImage) removeFileIfLocal(pkg.hostImage);
    pkg.hostImage = buildUrl(hostImageFile);
  }

  await pkg.save();

  if (body.categoryIds !== undefined) await pkg.setCategories(parseIntArray(body.categoryIds));
  if (body.problemIds !== undefined) await pkg.setProblems(parseIntArray(body.problemIds));
  if (body.activityIds !== undefined) await pkg.setActivities(parseIntArray(body.activityIds));
  if (body.nearbyPlaceIds !== undefined) await pkg.setNearbyPlaces(parseIntArray(body.nearbyPlaceIds));
  if (body.areaIds !== undefined) await pkg.setAreas(parseIntArray(body.areaIds));
  if (body.cultureIds !== undefined) await pkg.setCultures(parseIntArray(body.cultureIds));
  if (body.trainerIds !== undefined) await pkg.setTrainers(parseIntArray(body.trainerIds));

  const newGalleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...parseJsonField(body.galleryUrls, [])];
  if (newGalleryAll.length) {
    if (body.replaceGallery === 'true') {
      const existing = await PackageImage.findAll({ where: { packageId: pkg.id } });
      existing.forEach((g) => removeFileIfLocal(g.url));
      await PackageImage.destroy({ where: { packageId: pkg.id } });
    }
    const offset = await PackageImage.count({ where: { packageId: pkg.id } });
    await PackageImage.bulkCreate(
      newGalleryAll.map((url, i) => ({ packageId: pkg.id, url, sortOrder: offset + i })),
    );
  }

  const fresh = await Package.findByPk(pkg.id, { include: baseInclude(false) });
  return ok(res, { package: fresh }, 'Package updated');
});

// POST /api/packages/:id/duplicate  (admin)
const duplicatePackage = asyncHandler(async (req, res) => {
  const original = await Package.findByPk(req.params.id, { include: baseInclude(false) });
  if (!original) return fail(res, 'Package not found', 404);

  const t = await sequelize.transaction();
  try {
    const data = original.toJSON();
    const slug = await ensureUniqueSlug(`${data.slug}-copy`);

    // strip fields that should not be copied
    [
      'id', 'slug', 'createdAt', 'updatedAt', 'rating', 'reviewCount',
      'interestedCount', 'city', 'location', 'categories', 'problems', 'activities',
      'nearbyPlaces', 'areas', 'cultures', 'trainers',
      'gallery', 'reviews',
    ].forEach((k) => delete data[k]);

    const copy = await Package.create(
      {
        ...data,
        name: original.name,
        slug,
        isActive: false, // start as draft
        isFeatured: false,
      },
      { transaction: t }
    );

    // M2M
    const categoryIds = (original.categories || []).map((c) => c.id);
    const problemIds = (original.problems || []).map((p) => p.id);
    const activityIds = (original.activities || []).map((a) => a.id);
    const nearbyPlaceIds = (original.nearbyPlaces || []).map((n) => n.id);
    const areaIds = (original.areas || []).map((a) => a.id);
    const cultureIds = (original.cultures || []).map((c) => c.id);
    const trainerIds = (original.trainers || []).map((tr) => tr.id);
    if (categoryIds.length) await copy.setCategories(categoryIds, { transaction: t });
    if (problemIds.length) await copy.setProblems(problemIds, { transaction: t });
    if (activityIds.length) await copy.setActivities(activityIds, { transaction: t });
    if (nearbyPlaceIds.length) await copy.setNearbyPlaces(nearbyPlaceIds, { transaction: t });
    if (areaIds.length) await copy.setAreas(areaIds, { transaction: t });
    if (cultureIds.length) await copy.setCultures(cultureIds, { transaction: t });
    if (trainerIds.length) await copy.setTrainers(trainerIds, { transaction: t });

    // Gallery — duplicate rows pointing at the same uploaded URLs (we don't
    // re-upload the binary; both packages share the cloud asset until edited).
    if (original.gallery?.length) {
      await PackageImage.bulkCreate(
        original.gallery.map((g, i) => ({
          packageId: copy.id,
          url: g.url,
          alt: g.alt,
          sortOrder: i,
        })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await Package.findByPk(copy.id, { include: baseInclude(false) });
    return created(res, { package: fresh }, 'Package duplicated');
  } catch (err) {
    await t.rollback();
    throw err;
  }
});

// PATCH /api/packages/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const pkg = await Package.findByPk(req.params.id);
  if (!pkg) return fail(res, 'Package not found', 404);
  pkg.isActive = !pkg.isActive;
  await pkg.save();
  return ok(res, { package: pkg }, `Package ${pkg.isActive ? 'published' : 'unpublished'}`);
});

// PUT /api/packages/admin/reorder  body: { order: [id, id, …] }
const reorderPackages = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);

  await Promise.all(
    order.map((id, idx) => Package.update({ sortOrder: idx }, { where: { id } }))
  );

  const items = await Package.findAll({
    order: [['sortOrder', 'ASC'], ['id', 'DESC']],
  });
  return ok(res, { items }, 'Reordered');
});

// DELETE /api/packages/:id
const removePackage = asyncHandler(async (req, res) => {
  const pkg = await Package.findByPk(req.params.id, {
    include: [{ model: PackageImage, as: 'gallery' }],
  });
  if (!pkg) return fail(res, 'Package not found', 404);

  if (pkg.primaryImage) removeFileIfLocal(pkg.primaryImage);
  if (pkg.hostImage) removeFileIfLocal(pkg.hostImage);
  pkg.gallery?.forEach((g) => removeFileIfLocal(g.url));

  await pkg.destroy();
  return ok(res, {}, 'Package deleted');
});

// DELETE /api/packages/:id/gallery/:imageId
const removeGalleryImage = asyncHandler(async (req, res) => {
  const img = await PackageImage.findOne({
    where: { id: req.params.imageId, packageId: req.params.id },
  });
  if (!img) return fail(res, 'Image not found', 404);
  removeFileIfLocal(img.url);
  await img.destroy();
  return ok(res, {}, 'Image removed');
});

// POST /api/packages/:id/check-availability  (public)
//
// Creates an AvailabilityLead, fires dummy voice calls to both the assigned
// owner and salesperson, and lets the PWA dashboards pick it up.
const submitAvailabilityRequest = asyncHandler(async (req, res) => {
  const { AvailabilityLead, Salesperson, PropertyOwner } = require('../models');
  const { placeCall } = require('../pwa/services/voiceCall');

  const pkg = await Package.findByPk(req.params.id);
  if (!pkg) return fail(res, 'Package not found', 404);
  if (!pkg.isActive) return fail(res, 'Package is not available', 400);

  const { customerName, customerPhone, customerEmail, requestedDate, notes } = req.body;
  if (!customerName?.trim()) return fail(res, 'Name is required', 400);
  if (!customerPhone?.trim()) return fail(res, 'Phone is required', 400);
  if (!requestedDate) return fail(res, 'Date is required', 400);

  const lead = await AvailabilityLead.create({
    packageId: pkg.id,
    ownerId: pkg.pwaOwnerId || null,
    salespersonId: pkg.pwaSalespersonId || null,
    customerName: customerName.trim(),
    customerPhone: customerPhone.trim(),
    customerEmail: customerEmail?.trim() || null,
    requestedDate,
    notes: notes?.trim() || null,
    status: 'pending',
  });

  // Resolve phone numbers — prefer the linked user record, fall back to the
  // contact details snapshot stored on the Package.
  let ownerPhone = pkg.ownerContactPhone;
  let ownerName  = pkg.ownerContactName;
  if (pkg.pwaOwnerId) {
    const owner = await PropertyOwner.findByPk(pkg.pwaOwnerId);
    if (owner) {
      ownerPhone = owner.phone || ownerPhone;
      ownerName  = owner.name  || ownerName;
    }
  }
  let salesPhone = null;
  let salesName  = null;
  if (pkg.pwaSalespersonId) {
    const sp = await Salesperson.findByPk(pkg.pwaSalespersonId);
    if (sp) {
      salesPhone = sp.phone;
      salesName  = sp.name;
    }
  }

  // Fire-and-forget the two voice calls. Don't block the response on these.
  if (ownerPhone) {
    placeCall({
      leadId: lead.id,
      recipientRole: 'owner',
      recipientPhone: ownerPhone,
      recipientName: ownerName,
      packageName: pkg.name,
      leadCustomerName: lead.customerName,
      leadDate: lead.requestedDate,
    }).then(() => AvailabilityLead.update(
      { ownerCallQueuedAt: new Date() },
      { where: { id: lead.id } },
    )).catch(() => {});
  }
  if (salesPhone) {
    placeCall({
      leadId: lead.id,
      recipientRole: 'salesperson',
      recipientPhone: salesPhone,
      recipientName: salesName,
      packageName: pkg.name,
      leadCustomerName: lead.customerName,
      leadDate: lead.requestedDate,
    }).then(() => AvailabilityLead.update(
      { salespersonCallQueuedAt: new Date() },
      { where: { id: lead.id } },
    )).catch(() => {});
  }

  return created(
    res,
    { lead },
    'Got it — our team will confirm availability shortly',
  );
});

// POST /api/packages/:id/interested  (public — increment)
const markInterested = asyncHandler(async (req, res) => {
  const pkg = await Package.findByPk(req.params.id);
  if (!pkg) return fail(res, 'Package not found', 404);
  pkg.interestedCount = (pkg.interestedCount || 0) + 1;
  await pkg.save();
  return ok(res, { interestedCount: pkg.interestedCount });
});

// Review endpoints scoped to packages now live in `/api/reviews` (see
// review.controller.js). The thin wrapper below preserves the legacy
// POST /api/packages/:id/reviews path the public PackageDetailPage used,
// forwarding the call into the unified Review controller with entityType
// auto-set so older clients keep working without changes.
const submitReview = asyncHandler(async (req, res, next) => {
  req.body = { ...req.body, entityType: 'package', entityId: req.params.id };
  return reviewCtrl.submit(req, res, next);
});

module.exports = {
  listPublic,
  priceStats,
  getBySlug,
  listAdmin,
  getAdminOne,
  createPackage,
  updatePackage,
  duplicatePackage,
  toggle,
  removePackage,
  removeGalleryImage,
  markInterested,
  submitAvailabilityRequest,
  submitReview,
  reorderPackages,
};

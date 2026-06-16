const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const {
  AvailableRoom,
  AvailableRoomImage,
  Hotel,
  Package,
  Facility,
  RoomView,
  sequelize,
} = require('../models');
const { normalizeGstRate } = require('../config/gst');
const { normalizeTcsRate } = require('../config/tcs');
const { normalizePriceType } = require('../config/priceType');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

// Slug uniqueness is per-owner — same slug "deluxe-suite" can exist under
// different hotels/packages. `scope` is { hotelId } or { packageId }.
const ensureUniqueSlug = async (scope, base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `room-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (
    await AvailableRoom.findOne({
      where: {
        ...scope,
        slug: candidate,
        ...(ignoreId && { id: { [Op.ne]: ignoreId } }),
      },
    })
  ) {
    candidate = `${slug}-${i++}`;
    if (i > 50) break;
  }
  return candidate;
};

// Resolve { ownerType, hotelId, packageId } from a request body, validating
// the referenced hotel/package exists. Returns { error } on failure.
const resolveOwner = async (body) => {
  const ownerType = body.ownerType === 'package' ? 'package' : 'hotel';
  if (ownerType === 'package') {
    if (!body.packageId) return { error: 'packageId is required' };
    const pkg = await Package.findByPk(parseInt(body.packageId, 10));
    if (!pkg) return { error: 'Package not found' };
    return { ownerType, hotelId: null, packageId: pkg.id, scope: { packageId: pkg.id } };
  }
  if (!body.hotelId) return { error: 'hotelId is required' };
  const hotel = await Hotel.findByPk(parseInt(body.hotelId, 10));
  if (!hotel) return { error: 'Hotel not found' };
  return { ownerType, hotelId: hotel.id, packageId: null, scope: { hotelId: hotel.id } };
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

// Sanitise extra-person pricing tiers coming from the admin form so booking
// maths can trust the shape. Drops malformed rows.
const normalizeTiers = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const ageFrom = parseInt(t.ageFrom, 10);
      const ageTo = parseInt(t.ageTo, 10);
      if (Number.isNaN(ageFrom) || Number.isNaN(ageTo)) return null;
      const priceType = t.priceType === 'custom' ? 'custom' : 'free';
      return {
        ageFrom: Math.max(0, Math.min(120, ageFrom)),
        ageTo: Math.max(0, Math.min(120, ageTo)),
        priceType,
        price: priceType === 'custom' ? Math.max(0, parseFloat(t.price) || 0) : 0,
        bed: t.bed === 'with' ? 'with' : 'without',
      };
    })
    .filter(Boolean);
};

const baseInclude = () => [
  { model: Hotel, as: 'hotel', attributes: ['id', 'name', 'slug', 'primaryImage'] },
  { model: Package, as: 'package', attributes: ['id', 'name', 'slug'] },
  { model: Facility, as: 'facilities', through: { attributes: [] } },
  { model: RoomView, as: 'views', through: { attributes: [] } },
  { model: AvailableRoomImage, as: 'gallery' },
];

// ─── Public ───────────────────────────────────────────────────────────────

// GET /api/rooms?hotelSlug=...   (public — list rooms for a hotel by slug)
const listPublicByHotel = asyncHandler(async (req, res) => {
  const { hotelSlug, hotelId } = req.query;
  if (!hotelSlug && !hotelId) {
    return fail(res, 'hotelSlug or hotelId is required', 400);
  }

  const hotel = hotelId
    ? await Hotel.findByPk(hotelId)
    : await Hotel.findOne({ where: { slug: hotelSlug } });
  if (!hotel) return fail(res, 'Hotel not found', 404);

  const rooms = await AvailableRoom.findAll({
    where: { hotelId: hotel.id, isActive: true },
    include: baseInclude(),
    order: [['sortOrder', 'ASC'], ['price', 'ASC']],
  });

  return ok(res, { items: rooms, hotel: { id: hotel.id, slug: hotel.slug, name: hotel.name } });
});

// GET /api/rooms/by-package?packageSlug=... or ?packageId=...  (public —
// list rooms attached to a package)
const listPublicByPackage = asyncHandler(async (req, res) => {
  const { packageSlug, packageId } = req.query;
  if (!packageSlug && !packageId) {
    return fail(res, 'packageSlug or packageId is required', 400);
  }

  const pkg = packageId
    ? await Package.findByPk(packageId)
    : await Package.findOne({ where: { slug: packageSlug } });
  if (!pkg) return fail(res, 'Package not found', 404);

  const rooms = await AvailableRoom.findAll({
    where: { packageId: pkg.id, isActive: true },
    include: baseInclude(),
    order: [['sortOrder', 'ASC'], ['price', 'ASC']],
  });

  return ok(res, { items: rooms, package: { id: pkg.id, slug: pkg.slug, name: pkg.name } });
});

// GET /api/rooms/by-slug?hotelSlug=...&roomSlug=...   (public — detail)
const getBySlug = asyncHandler(async (req, res) => {
  const { hotelSlug, roomSlug } = req.query;
  if (!hotelSlug || !roomSlug) return fail(res, 'hotelSlug and roomSlug are required', 400);

  const hotel = await Hotel.findOne({ where: { slug: hotelSlug, isActive: true } });
  if (!hotel) return fail(res, 'Hotel not found', 404);

  const room = await AvailableRoom.findOne({
    where: { hotelId: hotel.id, slug: roomSlug, isActive: true },
    include: baseInclude(),
  });
  if (!room) return fail(res, 'Room not found', 404);

  return ok(res, { room });
});

// ─── Admin ────────────────────────────────────────────────────────────────

// GET /api/rooms/admin/all?hotelId=...&packageId=...   (admin — list,
// optionally filtered by owning hotel or package)
const listAdmin = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.hotelId) where.hotelId = parseInt(req.query.hotelId, 10);
  if (req.query.packageId) where.packageId = parseInt(req.query.packageId, 10);
  if (req.query.ownerType === 'hotel') where.ownerType = 'hotel';
  if (req.query.ownerType === 'package') where.ownerType = 'package';

  const items = await AvailableRoom.findAll({
    where,
    include: baseInclude(),
    order: [['ownerType', 'ASC'], ['hotelId', 'ASC'], ['packageId', 'ASC'], ['sortOrder', 'ASC'], ['id', 'DESC']],
  });
  return ok(res, { items });
});

// GET /api/rooms/admin/:id
const getAdminOne = asyncHandler(async (req, res) => {
  const room = await AvailableRoom.findByPk(req.params.id, { include: baseInclude() });
  if (!room) return fail(res, 'Room not found', 404);
  return ok(res, { room });
});

// POST /api/rooms   (admin — multipart mainImage + gallery[])
const createRoom = asyncHandler(async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const body = req.body;
    if (!body.name?.trim()) {
      await t.rollback();
      return fail(res, 'name is required', 400);
    }

    const owner = await resolveOwner(body);
    if (owner.error) {
      await t.rollback();
      return fail(res, owner.error, 400);
    }

    const slug = await ensureUniqueSlug(owner.scope, body.slug || body.name);

    const mainImageFile = req.files?.mainImage?.[0];
    const galleryFiles = req.files?.gallery || [];

    const room = await AvailableRoom.create(
      {
        ownerType: owner.ownerType,
        hotelId: owner.hotelId,
        packageId: owner.packageId,
        name: body.name,
        slug,
        price: body.price ? parseFloat(body.price) : 0,
        priceOriginal: body.priceOriginal ? parseFloat(body.priceOriginal) : null,
        gstRate: normalizeGstRate(body.gstRate),
        tcsRate: normalizeTcsRate(body.tcsRate),
        priceType: normalizePriceType(body.priceType) || 'per_night',
        priceLabel: body.priceLabel ? String(body.priceLabel).slice(0, 60) : null,
        currency: body.currency || 'INR',
        roomSize: body.roomSize || null,
        maxOccupancy: body.maxOccupancy ? parseInt(body.maxOccupancy, 10) : 2,
        maxChildrenFree: body.maxChildrenFree ? parseInt(body.maxChildrenFree, 10) : 0,
        extraPersonTiers: normalizeTiers(parseJsonField(body.extraPersonTiers, [])),
        mainImage: body.mainImageUrl || (mainImageFile ? buildUrl(mainImageFile) : null),
        highlightsRich: body.highlightsRich || null,
        descriptionRich: body.descriptionRich || null,
        isFeatured: body.isFeatured === 'true',
        isActive: body.isActive === 'false' ? false : true,
        isRefundable: body.isRefundable === 'false' ? false : true,
        sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
      },
      { transaction: t }
    );

    const facilityIds = parseIntArray(body.facilityIds);
    const viewIds = parseIntArray(body.viewIds);
    if (facilityIds.length) await room.setFacilities(facilityIds, { transaction: t });
    if (viewIds.length) await room.setViews(viewIds, { transaction: t });

    const galleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...parseJsonField(body.galleryUrls, [])];
    if (galleryAll.length) {
      await AvailableRoomImage.bulkCreate(
        galleryAll.map((url, i) => ({ roomId: room.id, url, sortOrder: i })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await AvailableRoom.findByPk(room.id, { include: baseInclude() });
    return created(res, { room: fresh }, 'Room created');
  } catch (err) {
    await t.rollback();
    Object.values(req.files || {}).forEach((arr) =>
      arr.forEach((f) => removeFileIfLocal(buildUrl(f)))
    );
    throw err;
  }
});

// PUT /api/rooms/:id  (admin)
const updateRoom = asyncHandler(async (req, res) => {
  const room = await AvailableRoom.findByPk(req.params.id);
  if (!room) return fail(res, 'Room not found', 404);

  const body = req.body;
  const mainImageFile = req.files?.mainImage?.[0];
  const galleryFiles = req.files?.gallery || [];

  // Allow re-parenting to a different hotel or package. Only re-resolve when
  // the client actually sends ownership fields.
  if (body.ownerType !== undefined || body.hotelId !== undefined || body.packageId !== undefined) {
    const owner = await resolveOwner({
      ownerType: body.ownerType || room.ownerType,
      hotelId: body.hotelId !== undefined ? body.hotelId : room.hotelId,
      packageId: body.packageId !== undefined ? body.packageId : room.packageId,
    });
    if (owner.error) return fail(res, owner.error, 400);
    room.ownerType = owner.ownerType;
    room.hotelId = owner.hotelId;
    room.packageId = owner.packageId;
  }

  if (body.name !== undefined) room.name = body.name;
  if (body.slug !== undefined && body.slug !== room.slug) {
    const scope = room.ownerType === 'package' ? { packageId: room.packageId } : { hotelId: room.hotelId };
    room.slug = await ensureUniqueSlug(scope, body.slug, room.id);
  }

  const directFields = ['currency', 'roomSize', 'highlightsRich', 'descriptionRich'];
  directFields.forEach((f) => {
    if (body[f] !== undefined) room[f] = body[f] === '' ? null : body[f];
  });

  if (body.price !== undefined && body.price !== '') room.price = parseFloat(body.price);
  if (body.priceOriginal !== undefined)
    room.priceOriginal = body.priceOriginal === '' ? null : parseFloat(body.priceOriginal);
  if (body.gstRate !== undefined) room.gstRate = normalizeGstRate(body.gstRate);
  if (body.tcsRate !== undefined) room.tcsRate = normalizeTcsRate(body.tcsRate);
  if (body.priceType !== undefined) room.priceType = normalizePriceType(body.priceType) || room.priceType;
  if (body.priceLabel !== undefined) room.priceLabel = body.priceLabel ? String(body.priceLabel).slice(0, 60) : null;
  if (body.maxOccupancy !== undefined && body.maxOccupancy !== '')
    room.maxOccupancy = parseInt(body.maxOccupancy, 10);
  if (body.maxChildrenFree !== undefined && body.maxChildrenFree !== '')
    room.maxChildrenFree = parseInt(body.maxChildrenFree, 10);
  if (body.extraPersonTiers !== undefined)
    room.extraPersonTiers = normalizeTiers(parseJsonField(body.extraPersonTiers, []));
  if (body.sortOrder !== undefined && body.sortOrder !== '')
    room.sortOrder = parseInt(body.sortOrder, 10);

  ['isFeatured', 'isActive', 'isRefundable'].forEach((f) => {
    if (body[f] !== undefined) room[f] = body[f] === 'true' || body[f] === true;
  });

  if (body.mainImageUrl !== undefined && body.mainImageUrl !== '') {
    room.mainImage = body.mainImageUrl;
  } else if (mainImageFile) {
    if (room.mainImage) removeFileIfLocal(room.mainImage);
    room.mainImage = buildUrl(mainImageFile);
  }

  await room.save();

  if (body.facilityIds !== undefined) await room.setFacilities(parseIntArray(body.facilityIds));
  if (body.viewIds !== undefined) await room.setViews(parseIntArray(body.viewIds));

  const newGalleryAll = [...galleryFiles.map((f) => buildUrl(f)), ...parseJsonField(body.galleryUrls, [])];
  if (newGalleryAll.length) {
    if (body.replaceGallery === 'true') {
      const existing = await AvailableRoomImage.findAll({ where: { roomId: room.id } });
      existing.forEach((g) => removeFileIfLocal(g.url));
      await AvailableRoomImage.destroy({ where: { roomId: room.id } });
    }
    const offset = await AvailableRoomImage.count({ where: { roomId: room.id } });
    await AvailableRoomImage.bulkCreate(
      newGalleryAll.map((url, i) => ({ roomId: room.id, url, sortOrder: offset + i })),
    );
  }

  const fresh = await AvailableRoom.findByPk(room.id, { include: baseInclude() });
  return ok(res, { room: fresh }, 'Room updated');
});

// POST /api/rooms/:id/duplicate  (admin)
const duplicateRoom = asyncHandler(async (req, res) => {
  const original = await AvailableRoom.findByPk(req.params.id, { include: baseInclude() });
  if (!original) return fail(res, 'Room not found', 404);

  const t = await sequelize.transaction();
  try {
    const data = original.toJSON();
    const scope = original.ownerType === 'package'
      ? { packageId: original.packageId }
      : { hotelId: original.hotelId };
    const slug = await ensureUniqueSlug(scope, `${data.slug}-copy`);

    ['id', 'slug', 'createdAt', 'updatedAt', 'hotel', 'package', 'facilities', 'views', 'gallery']
      .forEach((k) => delete data[k]);

    const copy = await AvailableRoom.create(
      {
        ...data,
        name: original.name,
        slug,
        // Non-null JSON columns: older rooms (pre-dating these columns) may hold
        // NULL — coerce to their defaults so the copy passes validation.
        facilitiesList: Array.isArray(data.facilitiesList) ? data.facilitiesList : [],
        extraPersonTiers: Array.isArray(data.extraPersonTiers) ? data.extraPersonTiers : [],
        gstRate: data.gstRate || 0,
        isActive: false,
        isFeatured: false,
      },
      { transaction: t }
    );

    const facilityIds = (original.facilities || []).map((f) => f.id);
    const viewIds = (original.views || []).map((v) => v.id);
    if (facilityIds.length) await copy.setFacilities(facilityIds, { transaction: t });
    if (viewIds.length) await copy.setViews(viewIds, { transaction: t });

    if (original.gallery?.length) {
      await AvailableRoomImage.bulkCreate(
        original.gallery.map((g, i) => ({
          roomId: copy.id,
          url: g.url,
          caption: g.caption,
          sortOrder: i,
        })),
        { transaction: t }
      );
    }

    await t.commit();
    const fresh = await AvailableRoom.findByPk(copy.id, { include: baseInclude() });
    return created(res, { room: fresh }, 'Room duplicated');
  } catch (err) {
    await t.rollback();
    throw err;
  }
});

// PATCH /api/rooms/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const room = await AvailableRoom.findByPk(req.params.id);
  if (!room) return fail(res, 'Room not found', 404);
  room.isActive = !room.isActive;
  await room.save();
  return ok(res, { room }, `Room ${room.isActive ? 'published' : 'unpublished'}`);
});

// PUT /api/rooms/admin/reorder   body: { order: [id, id, …] }
const reorderRooms = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => AvailableRoom.update({ sortOrder: idx }, { where: { id } })));
  return ok(res, {}, 'Reordered');
});

// DELETE /api/rooms/:id
const removeRoom = asyncHandler(async (req, res) => {
  const room = await AvailableRoom.findByPk(req.params.id, {
    include: [{ model: AvailableRoomImage, as: 'gallery' }],
  });
  if (!room) return fail(res, 'Room not found', 404);

  if (room.mainImage) removeFileIfLocal(room.mainImage);
  room.gallery?.forEach((g) => removeFileIfLocal(g.url));

  await room.destroy();
  return ok(res, {}, 'Room deleted');
});

// DELETE /api/rooms/:id/gallery/:imageId
const removeGalleryImage = asyncHandler(async (req, res) => {
  const img = await AvailableRoomImage.findOne({
    where: { id: req.params.imageId, roomId: req.params.id },
  });
  if (!img) return fail(res, 'Image not found', 404);
  removeFileIfLocal(img.url);
  await img.destroy();
  return ok(res, {}, 'Image removed');
});

module.exports = {
  listPublicByHotel,
  listPublicByPackage,
  getBySlug,
  listAdmin,
  getAdminOne,
  createRoom,
  updateRoom,
  duplicateRoom,
  toggle,
  reorderRooms,
  removeRoom,
  removeGalleryImage,
};

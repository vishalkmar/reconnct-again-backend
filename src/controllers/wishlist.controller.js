const asyncHandler = require('express-async-handler');
const {
  WishlistItem,
  Package,
  AvailableRoom,
  Hotel,
  Event,
  EventType,
  AddOnActivity,
  Experience,
  ExperienceCategory,
  Location,
  City,
} = require('../models');
const { ok, fail } = require('../utils/response');

const ALLOWED_TYPES = ['package', 'room', 'event', 'addon', 'experience'];

// Fetch the underlying bookable entity in a uniform shape. Returning `null`
// signals a dangling wishlist row (item deleted/deactivated) so the list
// endpoint can prune it lazily.
const hydrateEntity = async (entityType, entityId) => {
  if (entityType === 'package') {
    const pkg = await Package.findByPk(entityId, {
      attributes: ['id', 'name', 'slug', 'primaryImage', 'priceFrom', 'priceOriginal', 'currency', 'locationDetail', 'durationDays', 'durationNights', 'isActive'],
      include: [
        { model: City, as: 'city', attributes: ['id', 'name'] },
        { model: Location, as: 'location', attributes: ['id', 'name'] },
      ],
    });
    if (!pkg || pkg.isActive === false) return null;
    const json = pkg.toJSON();
    return {
      type: 'package',
      id: json.id,
      name: json.name,
      slug: json.slug,
      image: json.primaryImage,
      price: Number(json.priceFrom || 0),
      priceOriginal: json.priceOriginal ? Number(json.priceOriginal) : null,
      currency: json.currency || 'INR',
      location: json.location?.name || json.city?.name || json.locationDetail || null,
      meta: { durationDays: json.durationDays, durationNights: json.durationNights },
      detailHref: `/retreats/${json.slug}`,
    };
  }

  if (entityType === 'room') {
    const room = await AvailableRoom.findByPk(entityId, {
      attributes: ['id', 'name', 'slug', 'mainImage', 'price', 'priceOriginal', 'currency', 'roomSize', 'maxOccupancy', 'isActive', 'hotelId'],
      include: [
        {
          model: Hotel,
          as: 'hotel',
          attributes: ['id', 'name', 'slug'],
          include: [
            { model: Location, as: 'location', attributes: ['id', 'name'] },
            { model: City, as: 'city', attributes: ['id', 'name'] },
          ],
        },
      ],
    });
    if (!room || room.isActive === false) return null;
    const json = room.toJSON();
    return {
      type: 'room',
      id: json.id,
      name: json.name,
      slug: json.slug,
      image: json.mainImage,
      price: Number(json.price || 0),
      priceOriginal: json.priceOriginal ? Number(json.priceOriginal) : null,
      currency: json.currency || 'INR',
      location: json.hotel?.location?.name || json.hotel?.city?.name || null,
      hotel: json.hotel ? { id: json.hotel.id, name: json.hotel.name, slug: json.hotel.slug } : null,
      meta: { roomSize: json.roomSize, maxOccupancy: json.maxOccupancy },
      detailHref: json.hotel?.slug ? `/hotels/${json.hotel.slug}/rooms/${json.slug}` : null,
    };
  }

  if (entityType === 'event') {
    const event = await Event.findByPk(entityId, {
      attributes: ['id', 'name', 'slug', 'mainImage', 'price', 'priceOriginal', 'currency', 'eventDate', 'startTime', 'endTime', 'isActive'],
      include: [
        { model: EventType, as: 'eventType', attributes: ['id', 'name', 'isSport'] },
        { model: Location, as: 'location', attributes: ['id', 'name'] },
      ],
    });
    if (!event || event.isActive === false) return null;
    const json = event.toJSON();
    return {
      type: 'event',
      id: json.id,
      name: json.name,
      slug: json.slug,
      image: json.mainImage,
      price: Number(json.price || 0),
      priceOriginal: json.priceOriginal ? Number(json.priceOriginal) : null,
      currency: json.currency || 'INR',
      location: json.location?.name || null,
      meta: {
        eventDate: json.eventDate,
        startTime: json.startTime,
        endTime: json.endTime,
        eventTypeName: json.eventType?.name,
        isSport: !!json.eventType?.isSport,
      },
      detailHref: `/events/${json.slug}`,
    };
  }

  if (entityType === 'experience') {
    const exp = await Experience.findByPk(entityId, {
      attributes: ['id', 'name', 'slug', 'mainImage', 'city', 'location', 'rating', 'pricing', 'priceMethod', 'currency', 'status', 'isActive'],
      include: [{ model: ExperienceCategory, as: 'category', attributes: ['id', 'name'] }],
    });
    if (!exp || exp.isActive === false || exp.status !== 'published') return null;
    const json = exp.toJSON();
    const adult = Number(json.pricing && json.pricing.adultPrice) || 0;
    return {
      type: 'experience',
      id: json.id,
      name: json.name,
      slug: json.slug,
      image: json.mainImage,
      mainImage: json.mainImage,
      price: adult,
      fromPrice: adult,
      priceUnit: 'person',
      currency: json.currency || 'INR',
      rating: Number(json.rating) || 0,
      city: json.city,
      category: json.category ? { id: json.category.id, name: json.category.name } : null,
      location: json.location || json.city || null,
      detailHref: `/experiences/${json.slug}`,
    };
  }

  if (entityType === 'addon') {
    const addon = await AddOnActivity.findByPk(entityId, {
      attributes: ['id', 'name', 'slug', 'mainImage', 'price', 'priceOriginal', 'currency', 'minAge', 'maxAge', 'isActive'],
      include: [{ model: Location, as: 'location', attributes: ['id', 'name'] }],
    });
    if (!addon || addon.isActive === false) return null;
    const json = addon.toJSON();
    return {
      type: 'addon',
      id: json.id,
      name: json.name,
      slug: json.slug,
      image: json.mainImage,
      price: Number(json.price || 0),
      priceOriginal: json.priceOriginal ? Number(json.priceOriginal) : null,
      currency: json.currency || 'INR',
      location: json.location?.name || null,
      meta: { minAge: json.minAge, maxAge: json.maxAge },
      detailHref: `/add-ons/${json.slug}`,
    };
  }

  return null;
};

// GET /api/wishlist  — full hydrated list for the signed-in user
const list = asyncHandler(async (req, res) => {
  const rows = await WishlistItem.findAll({
    where: { userId: req.user.id },
    order: [['createdAt', 'DESC']],
  });

  const hydrated = [];
  const orphanIds = [];
  for (const row of rows) {
    const entity = await hydrateEntity(row.entityType, row.entityId);
    if (entity) {
      hydrated.push({ wishlistId: row.id, addedAt: row.createdAt, ...entity });
    } else {
      orphanIds.push(row.id);
    }
  }

  // Best-effort cleanup of wishlist rows pointing at deleted/inactive items so
  // the list stays accurate over time. Failure here is non-fatal.
  if (orphanIds.length) {
    WishlistItem.destroy({ where: { id: orphanIds } }).catch(() => {});
  }

  return ok(res, {
    items: hydrated,
    count: hydrated.length,
    byType: hydrated.reduce((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {}),
  });
});

// GET /api/wishlist/keys — light endpoint returning just the (type, id) pairs.
// Used by the frontend on every page load to render heart-filled states
// without hydrating the whole list.
const keys = asyncHandler(async (req, res) => {
  const rows = await WishlistItem.findAll({
    where: { userId: req.user.id },
    attributes: ['entityType', 'entityId'],
  });
  return ok(res, {
    keys: rows.map((r) => `${r.entityType}:${r.entityId}`),
  });
});

// POST /api/wishlist  { entityType, entityId }
const add = asyncHandler(async (req, res) => {
  const entityType = String(req.body.entityType || '').toLowerCase();
  const entityId = parseInt(req.body.entityId, 10);

  if (!ALLOWED_TYPES.includes(entityType)) {
    return fail(res, 'Invalid item type', 400);
  }
  if (!Number.isInteger(entityId) || entityId <= 0) {
    return fail(res, 'Invalid item id', 400);
  }

  // Confirm the entity actually exists before saving so we never store rows
  // pointing at nothing.
  const entity = await hydrateEntity(entityType, entityId);
  if (!entity) {
    return fail(res, 'Item not found', 404);
  }

  const [row, created] = await WishlistItem.findOrCreate({
    where: { userId: req.user.id, entityType, entityId },
    defaults: { userId: req.user.id, entityType, entityId },
  });

  return ok(res, {
    wishlistId: row.id,
    entity,
    alreadyExisted: !created,
  }, created ? 'Saved to wishlist' : 'Already in wishlist');
});

// DELETE /api/wishlist  { entityType, entityId }
const remove = asyncHandler(async (req, res) => {
  const entityType = String(req.body.entityType || req.query.entityType || '').toLowerCase();
  const entityId = parseInt(req.body.entityId || req.query.entityId, 10);

  if (!ALLOWED_TYPES.includes(entityType)) return fail(res, 'Invalid item type', 400);
  if (!Number.isInteger(entityId) || entityId <= 0) return fail(res, 'Invalid item id', 400);

  const deleted = await WishlistItem.destroy({
    where: { userId: req.user.id, entityType, entityId },
  });

  return ok(res, { removed: deleted > 0 }, deleted ? 'Removed from wishlist' : 'Was not in wishlist');
});

module.exports = { list, keys, add, remove };

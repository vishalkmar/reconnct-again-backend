const slugify = require('slugify');
const db = require('../../models'); // website models

const { Hotel, AvailableRoom, HotelImage, AvailableRoomImage, Package, Event } = db;

// ── helpers ────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Apply a price modifier. `kind` = 'markup' (add) | 'discount' (subtract).
// `type` = 'percent' | 'fixed'.
const applyMod = (price, mk) => {
  const p = Number(price) || 0;
  if (!mk) return p;
  const v = Number(mk.value) || 0;
  if (!v) return p;
  const delta = mk.type === 'fixed' ? v : p * (v / 100);
  return Math.max(0, mk.kind === 'discount' ? p - delta : p + delta);
};

// Pick the modifier for a specific room: per-room override if configured, else
// the top-level "total" markup applied uniformly per room.
const roomModFor = (markup, roomKey) => {
  if (markup?.mode === 'per_room' && markup.perRoom?.[roomKey]) return markup.perRoom[roomKey];
  return { kind: markup?.kind || 'markup', type: markup?.type || 'percent', value: markup?.value || 0 };
};

const uniqueSlug = async (Model, base, scope = {}) => {
  let slug = slugify(base || 'item', { lower: true, strict: true }) || 'item';
  let candidate = slug;
  let i = 1;
  while (await Model.findOne({ where: { ...scope, slug: candidate } })) {
    candidate = `${slug}-${i++}`;
    if (i > 200) break;
  }
  return candidate;
};

const getRooms = (property) => {
  const field = (property.fields || []).find((f) => f.sectionKey === 'rooms');
  const rooms = field?.deepDiveData?.rooms;
  return Array.isArray(rooms) ? rooms : [];
};

// room.photos = { categoryKey: [url, …] } → flat list of urls.
const roomPhotos = (room) => {
  const out = [];
  Object.values(room?.photos || {}).forEach((arr) => { if (Array.isArray(arr)) out.push(...arr); });
  return out.filter(Boolean);
};

// Every photo captured across all PWA sections (cctv, garden, …) — candidates
// for the hotel gallery. Honours per-section remove/add overrides from the
// admin's sectionConfig.
const sectionPhotos = (property, sectionConfig = {}) => {
  const out = [];
  (property.fields || []).forEach((f) => {
    if (f.sectionKey === 'rooms') return; // room photos go to the rooms
    const sc = sectionConfig[f.sectionKey] || {};
    if (sc.enabled === false) return; // section hidden from the website
    const removed = new Set(Array.isArray(sc.removed) ? sc.removed : []);
    (Array.isArray(f.photoUrls) ? f.photoUrls : []).forEach((u) => { if (u && !removed.has(u)) out.push(u); });
    (Array.isArray(sc.added) ? sc.added : []).forEach((u) => { if (u) out.push(u); });
  });
  return out;
};

// Section-level custom fields → standalone titled blocks (same shape as the
// global additional fields). Hidden sections are skipped.
const sectionExtraSections = (sectionConfig = {}) => {
  const out = [];
  Object.values(sectionConfig).forEach((sc) => {
    if (sc?.enabled === false) return;
    (sc?.customFields || []).forEach((f) => {
      if (f && f.value) out.push({ name: String(f.name || '').trim(), type: f.kind === 'image' ? 'image' : 'text', value: String(f.value) });
    });
  });
  return out;
};

// Rich custom text fields → HTML. The NAME is escaped (plain text) but the
// VALUE is left raw because it already comes from the rich-text editor as HTML
// (escaping it would surface literal <div> tags on the page).
const customTextHtml = (fields) => (fields || [])
  .filter((f) => f.kind === 'text' && f.value)
  .map((f) => `${f.name ? `<h4>${esc(f.name)}</h4>` : ''}${f.value}`)
  .join('');

const customImages = (fields) => (fields || [])
  .filter((f) => f.kind === 'image' && f.value)
  .map((f) => f.value);

// Admin "additional fields" → standalone titled sections on the public detail
// page (NOT folded into the About description). Text values keep their HTML so
// the rich-text editor's formatting survives; image values are URLs.
const buildExtraSections = (fields) => (fields || [])
  .filter((f) => f.value)
  .map((f, i) => ({
    name: String(f.name || '').trim(),
    type: f.kind === 'image' ? 'image' : 'text',
    value: String(f.value),
    sortOrder: i,
  }));

const emptyHtml = (s) => !s || !String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '').trim();

// Map a PWA bed type to a sensible max occupancy.
const bedToOccupancy = (bedType) => {
  const t = String(bedType || '').toLowerCase();
  if (t.includes('triple')) return 3;
  if (t.includes('quad') || t.includes('family')) return 4;
  if (t.includes('single')) return 1;
  return 2; // double / default
};

// Apply admin remove/add overrides to a source image list.
const applyImageOverrides = (source, override = {}) => {
  const removed = new Set(Array.isArray(override.removed) ? override.removed : []);
  const added = Array.isArray(override.added) ? override.added : [];
  const kept = source.filter((u) => !removed.has(u));
  // de-dup while preserving order
  return [...new Set([...kept, ...added])];
};

// ── publishers ───────────────────────────────────────────────────────────

async function publishHotel(property, config) {
  const markup = config.markup || {};
  const roomConfig = config.roomConfig || {};
  const listingImgs = (property.listingImages || []).map((li) => li.url).filter(Boolean);
  const rooms = getRooms(property);

  // Hotel gallery candidates: listing images + every (override-applied) section
  // photo. Admin can remove any and add their own (config.gallery.added). Custom
  // IMAGE fields go to their own titled sections, not the gallery.
  const sectionConfig = config.sectionConfig || {};
  const galleryCandidates = [...listingImgs, ...sectionPhotos(property, sectionConfig)];
  const hotelGallery = applyImageOverrides(galleryCandidates, config.gallery || {});
  const firstPhoto = hotelGallery[0] || (rooms.length ? roomPhotos(rooms[0])[0] : null);

  const slug = await uniqueSlug(Hotel, property.name);
  const hotel = await Hotel.create({
    name: property.name,
    slug,
    address: property.address || null,
    cityName: property.locationText || null,
    primaryImage: firstPhoto || null,
    // Predefined editable content → proper website sections.
    shortDescription: emptyHtml(config.shortDescription) ? (property.locationText || null) : config.shortDescription,
    description: emptyHtml(config.longDescription) ? null : config.longDescription,
    highlightsRich: emptyHtml(config.highlights) ? null : config.highlights,
    // Admin "additional fields" (global + per-section) render as their own
    // titled blocks, not the About description.
    extraSections: [...buildExtraSections(config.customFields), ...sectionExtraSections(sectionConfig)],
    currency: 'INR',
    isActive: true,
  });

  if (hotelGallery.length) {
    await HotelImage.bulkCreate(hotelGallery.map((url, i) => ({ hotelId: hotel.id, url, sortOrder: i })));
  }

  let cheapest = null;
  for (const room of rooms) {
    const rc = roomConfig[room.rid] || {};
    // Base price: admin-entered (PWA doesn't capture room prices) wins, else any
    // PWA value, then markup/discount is applied on top.
    const basePrice = rc.price != null && rc.price !== '' ? Number(rc.price) : Number(room.price) || 0;
    const price = applyMod(basePrice, roomModFor(markup, room.rid));
    // Per-room GST → falls back to the global markup GST.
    const gstRate = rc.gstRate != null ? rc.gstRate : (markup.gstRate || 0);
    // Only priced rooms (> 0) set the "from" price so a free/unpriced room
    // never drags it to ₹0.
    if (price > 0 && (cheapest === null || price < cheapest)) cheapest = price;
    const roomName = (rc.name && rc.name.trim()) || room.category || 'Room';
    const rslug = await uniqueSlug(AvailableRoom, roomName, { hotelId: hotel.id });

    // Facilities: admin override (strings) else the PWA list. Stored as a list
    // for chip display.
    const facilities = Array.isArray(rc.facilities) ? rc.facilities : (Array.isArray(room.facilities) ? room.facilities : []);
    // Per-room pre-defined content (admin) → room columns. Long description also
    // carries any admin custom fields appended after it.
    const highlights = !emptyHtml(rc.highlights) ? rc.highlights : (room.highlights || null);
    const longDesc = !emptyHtml(rc.longDescription) ? rc.longDescription : null;
    const customHtml = customTextHtml(rc.customFields);
    const descHtml = [longDesc, customHtml].filter(Boolean).join('') || null;
    const shortDesc = !emptyHtml(rc.shortDescription) ? rc.shortDescription : null;
    const inclusions = !emptyHtml(rc.inclusions) ? rc.inclusions : null;
    const exclusions = !emptyHtml(rc.exclusions) ? rc.exclusions : null;

    // Room photos with admin remove/add + optional main-image override.
    const photos = applyImageOverrides(roomPhotos(room), rc);
    const mainImage = rc.mainImage || photos[0] || null;

    const created = await AvailableRoom.create({
      ownerType: 'hotel',
      hotelId: hotel.id,
      packageId: null,
      name: roomName,
      slug: rslug,
      price,
      gstRate,
      currency: 'INR',
      roomSize: room.sizeSqft ? `${room.sizeSqft} sqft` : null,
      maxOccupancy: bedToOccupancy(room.bedType),
      facilitiesList: facilities,
      mainImage,
      shortDescription: shortDesc,
      highlightsRich: highlights,
      descriptionRich: descHtml,
      inclusionsRich: inclusions,
      exclusionsRich: exclusions,
      extraPersonTiers: Array.isArray(room.extraPersonTiers) ? room.extraPersonTiers : [],
      isActive: true,
    });
    const roomGallery = [...new Set([...(rc.mainImage ? [rc.mainImage] : []), ...photos, ...customImages(rc.customFields)])];
    if (roomGallery.length) {
      await AvailableRoomImage.bulkCreate(roomGallery.map((url, i) => ({ roomId: created.id, url, sortOrder: i })));
    }
  }

  if (cheapest !== null) {
    hotel.priceFrom = cheapest;
    await hotel.save();
  }

  return { linkedType: 'hotel', linkedId: hotel.id };
}

// Package / Event share a basic shape (no per-room model).
async function publishSimple(property, config, kind) {
  const Model = kind === 'event' ? Event : Package;
  const markup = config.markup || {};
  const roomConfig = config.roomConfig || {};
  const rooms = getRooms(property);
  const listingImgs = (property.listingImages || []).map((li) => li.url).filter(Boolean);
  const basePriceOf = (r) => {
    const rc = roomConfig[r.rid] || {};
    return rc.price != null && rc.price !== '' ? Number(rc.price) : Number(r.price) || 0;
  };
  const prices = rooms.map((r) => applyMod(basePriceOf(r), roomModFor(markup, r.rid))).filter((p) => p > 0);
  // Packages/events can also carry a single price typed straight into the
  // config (no rooms) — fall back to the top-level markup value as the price.
  const cheapest = prices.length ? Math.min(...prices) : 0;

  const sectionConfig = config.sectionConfig || {};
  const galleryCandidates = [...listingImgs, ...sectionPhotos(property, sectionConfig)];
  const gallery = applyImageOverrides(galleryCandidates, config.gallery || {});

  const slug = await uniqueSlug(Model, property.name);
  const extraSections = [...buildExtraSections(config.customFields), ...sectionExtraSections(sectionConfig)];
  // Use the cheapest priced tier's GST, else the global markup GST.
  let gstRate = markup.gstRate || 0;
  const cheapRoom = rooms.find((r) => applyMod(basePriceOf(r), roomModFor(markup, r.rid)) === cheapest);
  if (cheapRoom) {
    const rc = roomConfig[cheapRoom.rid] || {};
    gstRate = rc.gstRate != null ? rc.gstRate : (markup.gstRate || 0);
  }

  const base = {
    name: property.name,
    slug,
    shortDescription: emptyHtml(config.shortDescription) ? (property.locationText || null) : config.shortDescription,
    description: emptyHtml(config.longDescription) ? null : config.longDescription,
    highlightsRich: emptyHtml(config.highlights) ? null : config.highlights,
    extraSections,
    gstRate,
    currency: 'INR',
    isActive: true,
    primaryImage: gallery[0] || null,
  };
  // Event uses `price`, Package uses `priceFrom`.
  if (kind === 'event') base.price = cheapest;
  else base.priceFrom = cheapest;
  const row = await Model.create(base);
  return { linkedType: kind, linkedId: row.id };
}

// Main entry — materialise the website entity from a PWA property + config.
async function publishListing(property, config) {
  const type = config.propertyType;
  if (type === 'hotel' || type === 'custom') return publishHotel(property, config);
  if (type === 'package') return publishSimple(property, config, 'package');
  if (type === 'event') return publishSimple(property, config, 'event');
  throw new Error('Pick a property type (hotel / package / event) before listing');
}

// Remove a previously-materialised entity (+ its rooms/images) so a re-publish
// re-creates it from the latest config.
async function removeEntity(type, id) {
  if (!type || !id) return;
  if (type === 'hotel') {
    const rooms = await AvailableRoom.findAll({ where: { hotelId: id }, attributes: ['id'] });
    const roomIds = rooms.map((r) => r.id);
    if (roomIds.length) await AvailableRoomImage.destroy({ where: { roomId: roomIds } });
    await AvailableRoom.destroy({ where: { hotelId: id } });
    await HotelImage.destroy({ where: { hotelId: id } });
    await Hotel.destroy({ where: { id } });
  } else if (type === 'package') {
    await Package.destroy({ where: { id } });
  } else if (type === 'event') {
    await Event.destroy({ where: { id } });
  }
}

module.exports = { publishListing, removeEntity, applyMod };

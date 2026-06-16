const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Property,
  PropertyField,
  PropertyOwner,
  Auditor,
  Officer,
  Contract,
  ListingImage,
  PwaListingConfig,
} = require('../models');
const { ok, fail } = require('../../utils/response');
const { Hotel, Package, Event } = require('../../models');
const { publishListing, removeEntity } = require('../services/listingPublish.service');
const { normalizeGstRate } = require('../../config/gst');

// Everything the admin needs to render a property as a dynamic, view-rich
// configuration form: basics + every captured section (incl. rooms), owner,
// auditor, officer, contract and the listing config itself.
const fullInclude = () => [
  { model: PropertyField, as: 'fields' },
  { model: PropertyOwner, as: 'owner', attributes: ['id', 'name', 'email', 'phone'] },
  { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
  { model: Officer, as: 'officer', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
  { model: Contract, as: 'contract' },
  { model: ListingImage, as: 'listingImages' },
  { model: PwaListingConfig, as: 'listingConfig' },
];

const listInclude = () => [
  { model: PropertyOwner, as: 'owner', attributes: ['id', 'name', 'email', 'phone'] },
  { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email'] },
  { model: Officer, as: 'officer', attributes: ['id', 'name', 'email'] },
  { model: PwaListingConfig, as: 'listingConfig' },
];

// GET /pwa/admin/listings/queue — properties the central officer pushed but
// the admin hasn't published yet (config still draft/unlisted).
const listQueue = asyncHandler(async (req, res) => {
  const items = await Property.findAll({
    where: { listingSubmittedAt: { [Op.ne]: null } },
    include: listInclude(),
    order: [['listingSubmittedAt', 'DESC']],
  });
  const pending = items.filter((p) => (p.listingConfig?.listingStatus || 'draft') !== 'listed');
  return ok(res, { items: pending });
});

// GET /pwa/admin/listings/listed — already published on the website.
const listListed = asyncHandler(async (req, res) => {
  const items = await Property.findAll({
    include: [
      ...listInclude().filter((i) => i.as !== 'listingConfig'),
      { model: PwaListingConfig, as: 'listingConfig', required: true, where: { listingStatus: 'listed' } },
    ],
    order: [['updatedAt', 'DESC']],
  });
  return ok(res, { items });
});

// GET /pwa/admin/listings/:id — full property + config for the editor.
const getOne = asyncHandler(async (req, res) => {
  const property = await Property.findByPk(req.params.id, { include: fullInclude() });
  if (!property) return fail(res, 'Property not found', 404);
  return ok(res, { property });
});

// Normalise the markup blob from the admin form into a trustworthy shape.
//   { mode:'total'|'per_room', type:'percent'|'fixed', value:Number,
//     perRoom: { [roomKey]: { type, value } } }
const normalizeMod = (v) => ({
  kind: v?.kind === 'discount' ? 'discount' : 'markup',
  type: v?.type === 'fixed' ? 'fixed' : 'percent',
  value: Math.max(0, parseFloat(v?.value) || 0),
});

const normalizeMarkup = (raw) => {
  const m = raw && typeof raw === 'object' ? raw : {};
  const out = {
    mode: m.mode === 'per_room' ? 'per_room' : 'total',
    ...normalizeMod(m),
    // Global GST (used in "same for all" mode, and as the per-room fallback).
    gstRate: normalizeGstRate(m.gstRate),
    perRoom: {},
  };
  if (m.perRoom && typeof m.perRoom === 'object') {
    for (const [k, v] of Object.entries(m.perRoom)) {
      if (!v) continue;
      out.perRoom[k] = normalizeMod(v);
    }
  }
  return out;
};

// Pass-through sanitiser for per-room/gallery image + custom-field overrides.
const normalizeRoomConfig = (raw) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [rid, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    out[rid] = {
      // Admin-entered base price (PWA onboarding does not capture room prices).
      price: v.price === '' || v.price == null ? null : Math.max(0, parseFloat(v.price) || 0),
      // Per-room GST (0 = Off). Falls back to the global markup GST at publish.
      gstRate: v.gstRate == null || v.gstRate === '' ? null : normalizeGstRate(v.gstRate),
      // Editable name + facilities (strings) + rich content override the PWA data.
      name: v.name != null ? String(v.name).slice(0, 200) : null,
      facilities: Array.isArray(v.facilities) ? v.facilities.map((f) => String(f).slice(0, 120)).filter(Boolean).slice(0, 100) : null,
      shortDescription: v.shortDescription != null ? String(v.shortDescription).slice(0, 20000) : null,
      longDescription: v.longDescription != null ? String(v.longDescription).slice(0, 50000) : null,
      highlights: v.highlights != null ? String(v.highlights).slice(0, 50000) : null,
      inclusions: v.inclusions != null ? String(v.inclusions).slice(0, 50000) : null,
      exclusions: v.exclusions != null ? String(v.exclusions).slice(0, 50000) : null,
      mainImage: v.mainImage ? String(v.mainImage) : '',
      removed: Array.isArray(v.removed) ? v.removed.map(String) : [],
      added: Array.isArray(v.added) ? v.added.map(String) : [],
      customFields: normalizeCustomFields(v.customFields),
    };
  }
  return out;
};

const normalizeGallery = (raw) => ({
  removed: Array.isArray(raw?.removed) ? raw.removed.map(String) : [],
  added: Array.isArray(raw?.added) ? raw.added.map(String) : [],
});

// Per-section image + custom-field overrides keyed by sectionKey.
const normalizeSectionConfig = (raw) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    out[key] = {
      // Whether this section's photos/fields are pushed to the website.
      enabled: v.enabled === false ? false : true,
      removed: Array.isArray(v.removed) ? v.removed.map(String) : [],
      added: Array.isArray(v.added) ? v.added.map(String) : [],
      customFields: normalizeCustomFields(v.customFields),
    };
  }
  return out;
};

// Sanitise the admin's dynamic custom fields.
//   [{ id, kind:'text'|'image', name, value }]
const normalizeCustomFields = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f, i) => ({
      id: String(f?.id || `cf-${i}-${Date.now()}`),
      kind: f?.kind === 'image' ? 'image' : 'text',
      name: String(f?.name || '').slice(0, 160),
      value: String(f?.value || '').slice(0, 5000),
    }))
    .filter((f) => f.name || f.value)
    .slice(0, 50);
};

// PUT /pwa/admin/listings/:id/config — save type, markup & custom fields.
const saveConfig = asyncHandler(async (req, res) => {
  const property = await Property.findByPk(req.params.id);
  if (!property) return fail(res, 'Property not found', 404);

  const body = req.body || {};
  const propertyType = ['hotel', 'package', 'event', 'custom'].includes(body.propertyType)
    ? body.propertyType
    : null;

  let config = await PwaListingConfig.findOne({ where: { propertyId: property.id } });
  if (!config) config = await PwaListingConfig.create({ propertyId: property.id, listingStatus: 'draft' });

  config.propertyType = propertyType;
  config.customType = body.customType ? String(body.customType).slice(0, 120) : null;
  config.categoryId = body.categoryId ? parseInt(body.categoryId, 10) : null;
  config.markup = normalizeMarkup(body.markup);
  config.customFields = normalizeCustomFields(body.customFields);
  config.shortDescription = body.shortDescription ? String(body.shortDescription).slice(0, 20000) : null;
  config.longDescription = body.longDescription ? String(body.longDescription).slice(0, 50000) : null;
  config.highlights = body.highlights ? String(body.highlights).slice(0, 50000) : null;
  config.gallery = normalizeGallery(body.gallery);
  config.roomConfig = normalizeRoomConfig(body.roomConfig);
  config.sectionConfig = normalizeSectionConfig(body.sectionConfig);
  await config.save();

  return ok(res, { config }, 'Listing configuration saved');
});

// POST /pwa/admin/listings/:id/publish — materialise the website entity from
// the PWA property + saved config, then mark the listing live.
const publish = asyncHandler(async (req, res) => {
  const property = await Property.findByPk(req.params.id, { include: fullInclude() });
  if (!property) return fail(res, 'Property not found', 404);

  const config = property.listingConfig;
  if (!config || !config.propertyType) {
    return fail(res, 'Set the property type before listing on the website', 400);
  }

  // Always re-materialise from the latest config. If a previous website entity
  // exists (re-publish), delete it first so config edits (markup, custom
  // fields, image swaps, type change) actually take effect.
  if (config.linkedId && config.linkedType) {
    await removeEntity(config.linkedType, config.linkedId);
  }
  const result = await publishListing(property, config);
  config.linkedType = result.linkedType;
  config.linkedId = result.linkedId;
  config.listingStatus = 'listed';
  config.listedAt = new Date();
  await config.save();

  return ok(res, { config }, 'Property is now live on the website');
});

// Flip the linked website entity's visibility.
const setEntityActive = async (type, id, active) => {
  const Model = type === 'package' ? Package : type === 'event' ? Event : Hotel;
  const row = await Model.findByPk(id);
  if (row) { row.isActive = active; await row.save(); }
};

// POST /pwa/admin/listings/:id/unlist — hide the website entity again.
const unlist = asyncHandler(async (req, res) => {
  const property = await Property.findByPk(req.params.id, {
    include: [{ model: PwaListingConfig, as: 'listingConfig' }],
  });
  if (!property) return fail(res, 'Property not found', 404);
  const config = property.listingConfig;
  if (!config || config.listingStatus !== 'listed') {
    return fail(res, 'This property is not currently listed', 400);
  }
  if (config.linkedId && config.linkedType) {
    await setEntityActive(config.linkedType, config.linkedId, false);
  }
  config.listingStatus = 'unlisted';
  await config.save();
  return ok(res, { config }, 'Property removed from the website');
});

// GET /pwa/admin/listings-process — every property currently in the onboarding
// pipeline, with owner/auditor/officer + live status (view-only for admins).
const onProcess = asyncHandler(async (req, res) => {
  const items = await Property.findAll({
    include: listInclude(),
    order: [['updatedAt', 'DESC']],
  });
  return ok(res, { items });
});

module.exports = {
  listQueue,
  listListed,
  getOne,
  saveConfig,
  publish,
  unlist,
  onProcess,
};

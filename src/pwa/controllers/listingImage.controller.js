const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { Property, ListingImage } = require('../models');
const { ok, created, fail } = require('../../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../../utils/uploads');
const { SECTION_KEY_SET, SECTION_KEYS, PROPERTY_STATUS } = require('../constants');

/*
  Final Listing Images flow — runs AFTER a property is approved by the
  centralize / officer pipeline. The auditor picks an approved property,
  expands a section (Entrance, Reception, …) and uploads / captures as
  many photos as they like (minimum 3 by UX, no hard cap). These photos
  feed into the public website's listing card later.
*/

// GET /api/pwa/auditor/listing-images/properties
//   List final-approved properties that THIS auditor created — the dropdown
//   in the PWA only shows what's safe to attach images to.
const listEligibleProperties = asyncHandler(async (req, res) => {
  const eligibleStatuses = [
    PROPERTY_STATUS.FINAL_APPROVED,
    PROPERTY_STATUS.CONTRACT_SENT,
    PROPERTY_STATUS.CONTRACT_SIGNED,
    PROPERTY_STATUS.COMPLETED,
  ];
  const items = await Property.findAll({
    where: {
      auditorId: req.pwaUser.id,
      status: { [Op.in]: eligibleStatuses },
    },
    attributes: ['id', 'name', 'address', 'propertyCode', 'status', 'approvedAt'],
    order: [['approvedAt', 'DESC'], ['id', 'DESC']],
  });
  return ok(res, { items });
});

// GET /api/pwa/auditor/listing-images/:propertyId
//   Return all listing images grouped by section, plus the section catalogue
//   (so the FE doesn't have to hardcode it).
const listForProperty = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.propertyId, auditorId: req.pwaUser.id },
    attributes: ['id', 'name', 'propertyCode', 'status'],
  });
  if (!property) return fail(res, 'Property not found', 404);

  const rows = await ListingImage.findAll({
    where: { propertyId: property.id },
    order: [['sectionKey', 'ASC'], ['sortOrder', 'ASC'], ['id', 'ASC']],
  });

  const grouped = {};
  SECTION_KEYS.forEach((s) => { grouped[s.key] = []; });
  rows.forEach((r) => {
    if (!grouped[r.sectionKey]) grouped[r.sectionKey] = [];
    grouped[r.sectionKey].push(r);
  });

  return ok(res, {
    property,
    sections: SECTION_KEYS,
    images: grouped,
  });
});

// POST /api/pwa/auditor/listing-images/:propertyId
//   Body (multipart):
//     sectionKey  — required, one of SECTION_KEYS
//     captureMode — 'live' | 'upload' (default 'upload')
//     photos[]    — files
//
//   Returns the newly inserted rows in order.
const uploadImages = asyncHandler(async (req, res) => {
  const { propertyId } = req.params;
  const { sectionKey, captureMode = 'upload' } = req.body;

  if (!SECTION_KEY_SET.has(sectionKey)) {
    return fail(res, 'Invalid section', 400);
  }
  if (!['live', 'upload'].includes(captureMode)) {
    return fail(res, 'Invalid capture mode', 400);
  }

  const property = await Property.findOne({
    where: { id: propertyId, auditorId: req.pwaUser.id },
  });
  if (!property) return fail(res, 'Property not found', 404);

  const eligible = [
    PROPERTY_STATUS.FINAL_APPROVED,
    PROPERTY_STATUS.CONTRACT_SENT,
    PROPERTY_STATUS.CONTRACT_SIGNED,
    PROPERTY_STATUS.COMPLETED,
  ];
  if (!eligible.includes(property.status)) {
    return fail(res, 'Listing images can only be added after final approval', 400);
  }

  const files = req.files || [];
  if (!files.length) return fail(res, 'At least one photo is required', 400);

  // Continue numbering after the highest existing sortOrder in this section
  const last = await ListingImage.findOne({
    where: { propertyId: property.id, sectionKey },
    order: [['sortOrder', 'DESC']],
    attributes: ['sortOrder'],
  });
  let nextOrder = (last?.sortOrder ?? -1) + 1;

  const rows = await Promise.all(
    files.map((file) =>
      ListingImage.create({
        propertyId: property.id,
        auditorId: req.pwaUser.id,
        sectionKey,
        url: getUploadedUrl(file),
        captureMode,
        sortOrder: nextOrder++,
      })
    )
  );

  return created(res, { items: rows }, 'Images uploaded');
});

// DELETE /api/pwa/auditor/listing-images/:propertyId/:imageId
const removeImage = asyncHandler(async (req, res) => {
  const { propertyId, imageId } = req.params;
  const property = await Property.findOne({
    where: { id: propertyId, auditorId: req.pwaUser.id },
  });
  if (!property) return fail(res, 'Property not found', 404);

  const row = await ListingImage.findOne({
    where: { id: imageId, propertyId: property.id },
  });
  if (!row) return fail(res, 'Image not found', 404);

  if (row.url) {
    try { await removeUploadedFile(row.url); } catch { /* swallow */ }
  }
  await row.destroy();
  return ok(res, {}, 'Image removed');
});

// PUT /api/pwa/auditor/listing-images/:propertyId/:imageId/caption
const updateCaption = asyncHandler(async (req, res) => {
  const { propertyId, imageId } = req.params;
  const { caption } = req.body;

  const property = await Property.findOne({
    where: { id: propertyId, auditorId: req.pwaUser.id },
  });
  if (!property) return fail(res, 'Property not found', 404);

  const row = await ListingImage.findOne({
    where: { id: imageId, propertyId: property.id },
  });
  if (!row) return fail(res, 'Image not found', 404);

  row.caption = (caption || '').trim() || null;
  await row.save();
  return ok(res, { item: row }, 'Caption saved');
});

module.exports = {
  listEligibleProperties,
  listForProperty,
  uploadImages,
  removeImage,
  updateCaption,
};

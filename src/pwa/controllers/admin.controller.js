const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const { Op } = require('sequelize');
const { Auditor, Officer, Property, Contract, ListingImage, Salesperson, AvailabilityLead, PropertyOwner } = require('../models');
const { Package } = require('../../models');
const { SECTION_KEYS } = require('../constants');
const { ok, created, fail } = require('../../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../../utils/uploads');
const { sendInvite } = require('../services/mailer');

// Pulls the actor admin from the existing site auth middleware. The route
// chains admin's `authenticate` before these handlers so req.admin is set.

const generateTempPassword = () => {
  // Easy-to-read 10-char temp password. Owner/Officer will be forced to
  // change on first login (frontend enforces) but the field still lives in
  // a normal password column.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10))
    .map((b) => alphabet[b % alphabet.length])
    .join('');
};

const buildFilter = (req) => {
  const { q, status } = req.query;
  const where = {};
  if (status === 'active') where.isActive = true;
  else if (status === 'inactive') where.isActive = false;
  if (q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${q}%` } },
      { email: { [Op.like]: `%${q}%` } },
      { phone: { [Op.like]: `%${q}%` } },
    ];
  }
  return where;
};

// -- Auditors ------------------------------------------------------------

const listAuditors = asyncHandler(async (req, res) => {
  const items = await Auditor.findAll({
    where: buildFilter(req),
    order: [['createdAt', 'DESC']],
  });
  return ok(res, { items: items.map((a) => a.toSafeJSON()) });
});

const getAuditor = asyncHandler(async (req, res) => {
  const a = await Auditor.findByPk(req.params.id);
  if (!a) return fail(res, 'Auditor not found', 404);
  return ok(res, { auditor: a.toSafeJSON() });
});

const createAuditor = asyncHandler(async (req, res) => {
  const { name, email, phone, dob, address } = req.body;
  if (!name?.trim() || !email?.trim()) {
    return fail(res, 'name and email are required', 400);
  }

  const normalized = email.toLowerCase().trim();
  const existing = await Auditor.findOne({ where: { email: normalized } });
  if (existing) return fail(res, 'An auditor with this email already exists', 409);

  const tempPassword = generateTempPassword();
  const profilePhotoUrl = req.file ? getUploadedUrl(req.file) : null;

  const auditor = await Auditor.create({
    name: name.trim(),
    email: normalized,
    password: tempPassword,
    phone: phone || null,
    dob: dob || null,
    address: address || null,
    profilePhotoUrl,
    createdByAdminId: req.admin?.id || null,
  });

  // Best-effort email — log but don't fail the request if mail server is
  // misconfigured, since the admin can resend or share creds another way.
  try {
    await sendInvite({
      to: normalized,
      name,
      role: 'Auditor',
      tempPassword,
      loginUrl: process.env.PWA_CLIENT_URL?.split(',')[0],
    });
  } catch (err) {
    console.warn('[PWA] sendInvite failed:', err.message);
  }

  return created(
    res,
    { auditor: auditor.toSafeJSON(), tempPassword },
    'Auditor created and invite email sent'
  );
});

const updateAuditor = asyncHandler(async (req, res) => {
  const a = await Auditor.findByPk(req.params.id);
  if (!a) return fail(res, 'Auditor not found', 404);

  ['name', 'phone', 'dob', 'address'].forEach((f) => {
    if (req.body[f] !== undefined) a[f] = req.body[f] === '' ? null : req.body[f];
  });

  if (req.body.email && req.body.email.toLowerCase().trim() !== a.email) {
    const dup = await Auditor.findOne({
      where: { email: req.body.email.toLowerCase().trim(), id: { [Op.ne]: a.id } },
    });
    if (dup) return fail(res, 'Another auditor already uses this email', 409);
    a.email = req.body.email.toLowerCase().trim();
    a.emailVerifiedAt = null;
  }

  if (req.file) {
    if (a.profilePhotoUrl) removeUploadedFile(a.profilePhotoUrl);
    a.profilePhotoUrl = getUploadedUrl(req.file);
  }

  await a.save();
  return ok(res, { auditor: a.toSafeJSON() }, 'Auditor updated');
});

const toggleAuditor = asyncHandler(async (req, res) => {
  const a = await Auditor.findByPk(req.params.id);
  if (!a) return fail(res, 'Auditor not found', 404);
  a.isActive = !a.isActive;
  await a.save();
  return ok(res, { auditor: a.toSafeJSON() }, `Auditor ${a.isActive ? 'activated' : 'deactivated'}`);
});

const resetAuditorPassword = asyncHandler(async (req, res) => {
  const a = await Auditor.findByPk(req.params.id);
  if (!a) return fail(res, 'Auditor not found', 404);
  const tempPassword = generateTempPassword();
  a.password = tempPassword;
  await a.save();
  try {
    await sendInvite({
      to: a.email, name: a.name, role: 'Auditor', tempPassword,
      loginUrl: process.env.PWA_CLIENT_URL?.split(',')[0],
    });
  } catch (err) {
    console.warn('[PWA] resetAuditorPassword mail failed:', err.message);
  }
  return ok(res, { tempPassword }, 'Password reset and emailed');
});

// -- Officers ------------------------------------------------------------

const listOfficers = asyncHandler(async (req, res) => {
  const items = await Officer.findAll({
    where: buildFilter(req),
    order: [['createdAt', 'DESC']],
  });
  const ids = items.map((o) => o.id);
  let stats = {};

  if (ids.length) {
    const [rows] = await require('../../config/database').sequelize.query(
      `
        SELECT
          p.assignedOfficerId AS officerId,
          SUM(CASE WHEN p.status IN ('approved', 'contract_sent', 'contract_signed', 'completed') THEN 1 ELSE 0 END) AS approvedCount,
          SUM(CASE WHEN p.status = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
          SUM(CASE WHEN p.status = 'in_revision' THEN 1 ELSE 0 END) AS followUpCount,
          SUM(CASE WHEN c.signedPdfUrl IS NOT NULL THEN 1 ELSE 0 END) AS signedCount
        FROM pwa_properties p
        LEFT JOIN pwa_contracts c ON c.propertyId = p.id
        WHERE p.assignedOfficerId IN (:ids)
        GROUP BY p.assignedOfficerId
      `,
      { replacements: { ids } }
    );

    stats = Object.fromEntries(rows.map((row) => [
      Number(row.officerId),
      {
        approvedCount: Number(row.approvedCount || 0),
        rejectedCount: Number(row.rejectedCount || 0),
        followUpCount: Number(row.followUpCount || 0),
        signedCount: Number(row.signedCount || 0),
      },
    ]));
  }

  return ok(res, {
    items: items.map((o) => ({
      ...o.toSafeJSON(),
      stats: stats[o.id] || {
        approvedCount: 0,
        rejectedCount: 0,
        followUpCount: 0,
        signedCount: 0,
      },
    })),
  });
});

const getOfficer = asyncHandler(async (req, res) => {
  const o = await Officer.findByPk(req.params.id);
  if (!o) return fail(res, 'Officer not found', 404);
  return ok(res, { officer: o.toSafeJSON() });
});

const createOfficer = asyncHandler(async (req, res) => {
  const { name, email, phone, dob, address } = req.body;
  if (!name?.trim() || !email?.trim()) {
    return fail(res, 'name and email are required', 400);
  }

  const normalized = email.toLowerCase().trim();
  const existing = await Officer.findOne({ where: { email: normalized } });
  if (existing) return fail(res, 'An officer with this email already exists', 409);

  const tempPassword = generateTempPassword();
  const profilePhotoUrl = req.file ? getUploadedUrl(req.file) : null;

  const officer = await Officer.create({
    name: name.trim(),
    email: normalized,
    password: tempPassword,
    phone: phone || null,
    dob: dob || null,
    address: address || null,
    profilePhotoUrl,
    createdByAdminId: req.admin?.id || null,
  });

  try {
    await sendInvite({
      to: normalized,
      name,
      role: 'Centralized Officer',
      tempPassword,
      loginUrl: process.env.PWA_CLIENT_URL?.split(',')[0],
    });
  } catch (err) {
    console.warn('[PWA] sendInvite (officer) failed:', err.message);
  }

  return created(
    res,
    { officer: officer.toSafeJSON(), tempPassword },
    'Officer created and invite email sent'
  );
});

const updateOfficer = asyncHandler(async (req, res) => {
  const o = await Officer.findByPk(req.params.id);
  if (!o) return fail(res, 'Officer not found', 404);

  ['name', 'phone', 'dob', 'address'].forEach((f) => {
    if (req.body[f] !== undefined) o[f] = req.body[f] === '' ? null : req.body[f];
  });

  if (req.body.email && req.body.email.toLowerCase().trim() !== o.email) {
    const dup = await Officer.findOne({
      where: { email: req.body.email.toLowerCase().trim(), id: { [Op.ne]: o.id } },
    });
    if (dup) return fail(res, 'Another officer already uses this email', 409);
    o.email = req.body.email.toLowerCase().trim();
    o.emailVerifiedAt = null;
  }

  if (req.file) {
    if (o.profilePhotoUrl) removeUploadedFile(o.profilePhotoUrl);
    o.profilePhotoUrl = getUploadedUrl(req.file);
  }

  await o.save();
  return ok(res, { officer: o.toSafeJSON() }, 'Officer updated');
});

const toggleOfficer = asyncHandler(async (req, res) => {
  const o = await Officer.findByPk(req.params.id);
  if (!o) return fail(res, 'Officer not found', 404);
  o.isActive = !o.isActive;
  await o.save();
  return ok(res, { officer: o.toSafeJSON() }, `Officer ${o.isActive ? 'activated' : 'deactivated'}`);
});

const resetOfficerPassword = asyncHandler(async (req, res) => {
  const o = await Officer.findByPk(req.params.id);
  if (!o) return fail(res, 'Officer not found', 404);
  const tempPassword = generateTempPassword();
  o.password = tempPassword;
  await o.save();
  try {
    await sendInvite({
      to: o.email, name: o.name, role: 'Centralized Officer', tempPassword,
      loginUrl: process.env.PWA_CLIENT_URL?.split(',')[0],
    });
  } catch (err) {
    console.warn('[PWA] resetOfficerPassword mail failed:', err.message);
  }
  return ok(res, { tempPassword }, 'Password reset and emailed');
});

const fetchRemoteBuffer = (url) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client.get(url, (remoteRes) => {
      if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location) {
        fetchRemoteBuffer(remoteRes.headers.location).then(resolve).catch(reject);
        return;
      }
      if (remoteRes.statusCode !== 200) {
        remoteRes.resume();
        reject(new Error(`Could not fetch signed document (${remoteRes.statusCode})`));
        return;
      }
      const chunks = [];
      remoteRes.on('data', (chunk) => chunks.push(chunk));
      remoteRes.on('end', () => {
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: remoteRes.headers['content-type'],
        });
      });
    }).on('error', reject);
  });

const documentFilename = (property, contract, contentType) => {
  const original = contract?.signedOriginalName;
  if (original && path.extname(original)) return original;
  if (/png/i.test(contentType || '')) return `signed-contract-${property.propertyCode}.png`;
  if (/jpe?g/i.test(contentType || '')) return `signed-contract-${property.propertyCode}.jpg`;
  return `signed-contract-${property.propertyCode}.pdf`;
};

// -- Signed properties ---------------------------------------------------

const listSignedProperties = asyncHandler(async (req, res) => {
  const where = { status: { [Op.in]: ['contract_signed', 'completed'] } };
  if (req.query.officerId) where.assignedOfficerId = req.query.officerId;

  const items = await Property.findAll({
    where,
    include: [
      {
        model: Contract,
        as: 'contract',
        required: true,
        where: { signedPdfUrl: { [Op.ne]: null } },
      },
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
      { model: Officer, as: 'officer', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
    ],
    order: [[{ model: Contract, as: 'contract' }, 'signedAt', 'DESC'], ['updatedAt', 'DESC']],
  });

  return ok(res, { items });
});

const downloadSignedProperty = asyncHandler(async (req, res) => {
  const property = await Property.findByPk(req.params.id, {
    include: [{ model: Contract, as: 'contract', required: true }],
  });
  if (!property || !property.contract?.signedPdfUrl) {
    return fail(res, 'Signed document not found', 404);
  }

  const { buffer, contentType } = await fetchRemoteBuffer(property.contract.signedPdfUrl);
  const detectedType = buffer.slice(0, 4).toString() === '%PDF'
    ? 'application/pdf'
    : property.contract.signedMimeType || contentType || 'application/octet-stream';
  const filename = documentFilename(property, property.contract, detectedType);

  res.setHeader('Content-Type', detectedType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

// -- Salespersons --------------------------------------------------------

const listSalespersons = asyncHandler(async (req, res) => {
  const items = await Salesperson.findAll({
    where: buildFilter(req),
    order: [['createdAt', 'DESC']],
  });
  return ok(res, { items: items.map((s) => s.toSafeJSON()) });
});

const getSalesperson = asyncHandler(async (req, res) => {
  const s = await Salesperson.findByPk(req.params.id);
  if (!s) return fail(res, 'Salesperson not found', 404);
  return ok(res, { salesperson: s.toSafeJSON() });
});

const createSalesperson = asyncHandler(async (req, res) => {
  const { name, email, phone, dob, address } = req.body;
  if (!name?.trim() || !email?.trim()) return fail(res, 'name and email are required', 400);

  const normalized = email.toLowerCase().trim();
  const existing = await Salesperson.findOne({ where: { email: normalized } });
  if (existing) return fail(res, 'A salesperson with this email already exists', 409);

  const tempPassword = generateTempPassword();
  const profilePhotoUrl = req.file ? getUploadedUrl(req.file) : null;

  const sp = await Salesperson.create({
    name: name.trim(),
    email: normalized,
    password: tempPassword,
    phone: phone || null,
    dob: dob || null,
    address: address || null,
    profilePhotoUrl,
    createdByAdminId: req.admin?.id || null,
  });

  try {
    await sendInvite({
      to: normalized,
      name,
      role: 'Salesperson',
      tempPassword,
      loginUrl: process.env.PWA_CLIENT_URL?.split(',')[0],
    });
  } catch (err) {
    console.warn('[PWA] sendInvite (salesperson) failed:', err.message);
  }

  return created(
    res,
    { salesperson: sp.toSafeJSON(), tempPassword },
    'Salesperson created and invite email sent',
  );
});

const updateSalesperson = asyncHandler(async (req, res) => {
  const s = await Salesperson.findByPk(req.params.id);
  if (!s) return fail(res, 'Salesperson not found', 404);

  ['name', 'phone', 'dob', 'address'].forEach((f) => {
    if (req.body[f] !== undefined) s[f] = req.body[f] === '' ? null : req.body[f];
  });

  if (req.body.email && req.body.email.toLowerCase().trim() !== s.email) {
    const dup = await Salesperson.findOne({
      where: { email: req.body.email.toLowerCase().trim(), id: { [Op.ne]: s.id } },
    });
    if (dup) return fail(res, 'Another salesperson already uses this email', 409);
    s.email = req.body.email.toLowerCase().trim();
    s.emailVerifiedAt = null;
  }

  if (req.file) {
    if (s.profilePhotoUrl) removeUploadedFile(s.profilePhotoUrl);
    s.profilePhotoUrl = getUploadedUrl(req.file);
  }

  await s.save();
  return ok(res, { salesperson: s.toSafeJSON() }, 'Salesperson updated');
});

const toggleSalesperson = asyncHandler(async (req, res) => {
  const s = await Salesperson.findByPk(req.params.id);
  if (!s) return fail(res, 'Salesperson not found', 404);
  s.isActive = !s.isActive;
  await s.save();
  return ok(res, { salesperson: s.toSafeJSON() }, `Salesperson ${s.isActive ? 'activated' : 'deactivated'}`);
});

const resetSalespersonPassword = asyncHandler(async (req, res) => {
  const s = await Salesperson.findByPk(req.params.id);
  if (!s) return fail(res, 'Salesperson not found', 404);
  const tempPassword = generateTempPassword();
  s.password = tempPassword;
  await s.save();
  try {
    await sendInvite({
      to: s.email, name: s.name, role: 'Salesperson', tempPassword,
      loginUrl: process.env.PWA_CLIENT_URL?.split(',')[0],
    });
  } catch (err) {
    console.warn('[PWA] resetSalespersonPassword mail failed:', err.message);
  }
  return ok(res, { tempPassword }, 'Password reset and emailed');
});

// -- Property owners (lookup for package form) ---------------------------

const listOwners = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.q) {
    where[Op.or] = [
      { name:  { [Op.like]: `%${req.query.q}%` } },
      { email: { [Op.like]: `%${req.query.q}%` } },
      { phone: { [Op.like]: `%${req.query.q}%` } },
    ];
  }
  const items = await PropertyOwner.findAll({
    where,
    attributes: ['id', 'name', 'email', 'phone'],
    order: [['name', 'ASC']],
    limit: 500,
  });
  return ok(res, { items });
});

// -- All availability leads (admin overview) -----------------------------

const listAllLeads = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.salespersonId) where.salespersonId = req.query.salespersonId;

  const items = await AvailabilityLead.findAll({
    where,
    include: [
      { model: Package, as: 'package', attributes: ['id', 'name', 'slug'] },
      { model: Salesperson, as: 'salesperson', attributes: ['id', 'name', 'email', 'phone'] },
    ],
    order: [['createdAt', 'DESC']],
    limit: 200,
  });
  return ok(res, { items });
});

// -- Final listing images (admin read-only view) -------------------------

// GET /api/pwa/admin/listing-images
//   Returns approved properties along with a count of saved listing images.
const listPropertiesWithListingImages = asyncHandler(async (req, res) => {
  const properties = await Property.findAll({
    where: { status: { [Op.in]: ['final_approved', 'contract_sent', 'contract_signed', 'completed'] } },
    attributes: ['id', 'name', 'address', 'propertyCode', 'status', 'approvedAt'],
    include: [
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email'] },
      { model: ListingImage, as: 'listingImages', attributes: ['id'] },
    ],
    order: [['approvedAt', 'DESC'], ['id', 'DESC']],
  });

  // Shape with imageCount only (don't ship every URL on the listing call)
  const items = properties.map((p) => {
    const json = p.toJSON();
    return { ...json, imageCount: json.listingImages?.length || 0, listingImages: undefined };
  });
  return ok(res, { items });
});

// GET /api/pwa/admin/listing-images/:propertyId
//   All listing images for one property, grouped by section.
const getListingImagesForProperty = asyncHandler(async (req, res) => {
  const property = await Property.findByPk(req.params.propertyId, {
    attributes: ['id', 'name', 'propertyCode', 'status', 'address', 'approvedAt'],
    include: [
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone'] },
    ],
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

  return ok(res, { property, sections: SECTION_KEYS, images: grouped });
});

module.exports = {
  listAuditors,
  getAuditor,
  createAuditor,
  updateAuditor,
  toggleAuditor,
  resetAuditorPassword,
  listOfficers,
  getOfficer,
  createOfficer,
  updateOfficer,
  toggleOfficer,
  resetOfficerPassword,
  listSignedProperties,
  downloadSignedProperty,
  listPropertiesWithListingImages,
  getListingImagesForProperty,
  // Salesperson
  listSalespersons,
  getSalesperson,
  createSalesperson,
  updateSalesperson,
  toggleSalesperson,
  resetSalespersonPassword,
  listAllLeads,
  listOwners,
};

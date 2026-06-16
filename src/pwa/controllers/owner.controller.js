const asyncHandler = require('express-async-handler');
const http = require('http');
const https = require('https');
const { Op } = require('sequelize');
const {
  Property,
  PropertyField,
  FieldReview,
  PropertyPhase4Data,
  Contract,
  Auditor,
  Officer,
  AvailabilityLead,
  Salesperson,
} = require('../models');
const { Package } = require('../../models');
const { ok, created, fail } = require('../../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../../utils/uploads');
const { emitToProperty } = require('../services/socket');
const { notifyUser } = require('../services/notifications');
const { sendSignedContractNotification } = require('../services/mailer');
const { generatePropertyCode } = require('../services/propertyId');
const {
  SECTION_KEY_SET, SECTION_KEYS,
  PHASE4_SCHEMA, PHASE4_FIELD_KEYS,
  PROPERTY_STATUS, FIELD_DECISION,
} = require('../constants');

// Stream a remote file (Cloudinary, S3, …) through this server so the
// client can request it as a same-origin auth-aware blob.
const fetchRemoteBuffer = (url) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client.get(url, (remote) => {
      if (remote.statusCode >= 300 && remote.statusCode < 400 && remote.headers.location) {
        fetchRemoteBuffer(remote.headers.location).then(resolve).catch(reject);
        return;
      }
      if (remote.statusCode !== 200) {
        remote.resume();
        reject(new Error(`Could not fetch (${remote.statusCode})`));
        return;
      }
      const chunks = [];
      remote.on('data', (c) => chunks.push(c));
      remote.on('end', () =>
        resolve({ buffer: Buffer.concat(chunks), contentType: remote.headers['content-type'] }),
      );
    }).on('error', reject);
  });

// Owner visibility — the owner sees every property tied to their email
// (linked auditor-onboarded properties AND ones they self-onboarded). For
// auditor-onboarded ones we hide rows still in draft / phase1, since those
// haven't been confirmed with the owner yet.
const ownedPropertyScope = (req) => ({
  [Op.or]: [
    { source: 'self', ownerId: req.pwaUser.id },
    {
      source: 'auditor',
      ownerEmail: req.pwaUser.email,
      status: { [Op.notIn]: ['draft'] },
    },
  ],
});

const propertyInclude = () => [
  { model: PropertyField, as: 'fields' },
  { model: FieldReview, as: 'reviews' },
  { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
  { model: Officer, as: 'officer', attributes: ['id', 'name', 'email'] },
  { model: Contract, as: 'contract' },
];

// Best-effort lookup of a property the owner is allowed to touch.
const loadOwnedProperty = async (req, where) =>
  Property.findOne({
    where: { ...where, ...ownedPropertyScope(req) },
    include: propertyInclude(),
  });

const minPhotosForSection = (property, sectionKey) => {
  if (sectionKey === 'trainer') return 2;
  return sectionKey === 'rooms' ? 0 : 3;
};

const ROOM_MANDATORY_PHOTOS = ['entrance', 'washroom', 'bedsheet', 'tv', 'almirah'];

const roomsSectionComplete = (property, field) => {
  if (!field?.description?.trim()) return false;
  const total = Number(property.numberOfRooms) || 0;
  const required = Math.ceil(total / 2);
  const data = field.deepDiveData || {};
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const categoryTotal = categories.reduce((sum, cat) => sum + (Number(cat.count) || 0), 0);
  return rooms.length >= required
    && categoryTotal === total
    && rooms.every((room) => (
      room.category?.trim()
      && ROOM_MANDATORY_PHOTOS.every((key) => (room.photos?.[key] || []).length > 0)
    ));
};

// -- Dashboard list / detail --------------------------------------------

// Mirrors the auditor's status filter set so an owner running in "self
// mode" gets the same All / Active / Following up / Objections / Completed
// / Final rejected buckets they would as an auditor of their own property.
const STATUS_BUCKETS = {
  active: {
    [Op.notIn]: [PROPERTY_STATUS.REJECTED, PROPERTY_STATUS.COMPLETED],
  },
  following: [PROPERTY_STATUS.IN_REVISION, PROPERTY_STATUS.IN_REVIEW],
  objections: [PROPERTY_STATUS.IN_REVISION, PROPERTY_STATUS.PHASE4_IN_REVISION],
  completed: [PROPERTY_STATUS.COMPLETED, PROPERTY_STATUS.CONTRACT_SIGNED],
  rejected: [PROPERTY_STATUS.REJECTED],
  pending_review: [PROPERTY_STATUS.PHASE3_SUBMITTED, PROPERTY_STATUS.PHASE4_SUBMITTED],
};

const listMyProperties = asyncHandler(async (req, res) => {
  const { source, status } = req.query;
  const baseWhere = ownedPropertyScope(req);
  const where = source === 'self' || source === 'auditor'
    ? { ...baseWhere, source }
    : { ...baseWhere };
  if (status && STATUS_BUCKETS[status]) {
    where.status = STATUS_BUCKETS[status];
  }
  const items = await Property.findAll({
    where,
    include: [
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
      { model: Contract, as: 'contract' },
    ],
    order: [['updatedAt', 'DESC']],
  });
  return ok(res, { items });
});

const getOneByCode = asyncHandler(async (req, res) => {
  const property = await loadOwnedProperty(req, { propertyCode: req.params.code });
  if (!property) return fail(res, 'Property not found', 404);
  return ok(res, { property });
});

const getOneById = asyncHandler(async (req, res) => {
  const property = await loadOwnedProperty(req, { id: req.params.id });
  if (!property) return fail(res, 'Property not found', 404);
  return ok(res, { property });
});

// Shared sign-upload core used by both code-keyed (legacy owner-link flow)
// and id-keyed (owner self-onboarding) routes.
const persistSignedUpload = async ({ req, property }) => {
  if (!property.contract?.sentAt && !property.contract?.generatedPdfUrl) {
    return { error: 'Contract has not been sent to you yet', status: 400 };
  }
  if (!req.file) {
    return { error: 'Upload a signed PDF or image', status: 400 };
  }
  let contract = await Contract.findOne({ where: { propertyId: property.id } });
  if (!contract) contract = await Contract.create({ propertyId: property.id });

  contract.signedPdfUrl = getUploadedUrl(req.file);
  contract.signedOriginalName = req.file.originalname || null;
  contract.signedMimeType = req.file.mimetype || null;
  contract.signedAt = new Date();
  contract.ownerSignedByEmail = req.pwaUser.email;
  await contract.save();

  // Signed copy now returns to the officer/auditor for the final signature.
  property.status = PROPERTY_STATUS.CONTRACT_SIGNED;
  await property.save();

  try {
    await sendSignedContractNotification({
      to: process.env.SIGNED_CONTRACT_NOTIFY_EMAIL || 'vk722413@gmail.com',
      ownerEmail: property.ownerEmail,
      ownerName: property.ownerName,
      propertyName: property.name,
      propertyCode: property.propertyCode,
      signedUrl: contract.signedPdfUrl,
      auditor: property.auditor,
      officer: property.officer,
    });
  } catch (err) {
    console.warn('[PWA] signed contract notification failed:', err.message);
  }

  // Real-time pings — bell + socket. The confirmation lands with whoever
  // brought the owner into the loop: the auditor for auditor-linked
  // properties (the auditor sent the contract email originally), the
  // officer for self-onboarded ones (the officer is the only reviewer in
  // the picture). The owner always sees the "listing live" toast.
  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
    contract,
  });
  const isSelf = property.source === 'self';
  if (!isSelf && property.auditorId) {
    notifyUser({
      role: 'auditor', userId: property.auditorId,
      type: 'contract_signed',
      title: `Signed contract uploaded: ${property.propertyCode || property.name}`,
      body: `${property.ownerName || property.ownerEmail} uploaded the e-signed contract. Mark onboarding complete from Contracts.`,
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  } else if (isSelf && property.assignedOfficerId) {
    notifyUser({
      role: 'officer', userId: property.assignedOfficerId,
      type: 'contract_signed',
      title: `Signed contract: ${property.propertyCode || property.name}`,
      body: 'Self-onboarded owner uploaded the signed copy. Upload the officer-signed final contract.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }
  if (property.ownerId) {
    notifyUser({
      role: 'owner', userId: property.ownerId,
      type: 'contract_signed',
      title: `Signed contract uploaded: ${property.propertyCode || property.name}`,
      body: isSelf
        ? 'Your signed copy is with the officer. Final signing is in progress.'
        : 'Your signed copy is with the auditor. Final completion is in progress.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }

  return { contract, property };
};

const uploadSignedContract = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { propertyCode: req.params.code, ...ownedPropertyScope(req) },
    include: [
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
      { model: Officer, as: 'officer', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
      { model: Contract, as: 'contract' },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);
  const result = await persistSignedUpload({ req, property });
  if (result.error) return fail(res, result.error, result.status);
  return ok(res, { contract: result.contract, property: result.property }, 'Signed contract uploaded');
});

const uploadSignedContractById = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...ownedPropertyScope(req) },
    include: [
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
      { model: Officer, as: 'officer', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
      { model: Contract, as: 'contract' },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);
  const result = await persistSignedUpload({ req, property });
  if (result.error) return fail(res, result.error, result.status);
  return ok(res, { contract: result.contract, property: result.property }, 'Signed contract uploaded');
});

// Shared streaming helper — handed a loaded property, proxies its
// generated PDF back through the owner endpoint so the browser can fetch
// it as a same-origin auth-aware blob.
const streamContractPdf = async (property, res) => {
  const pdfUrl = property?.contract?.finalPdfUrl || property?.contract?.generatedPdfUrl;
  if (!pdfUrl) {
    return fail(res, 'Contract PDF is not ready yet', 404);
  }
  try {
    const { buffer, contentType } = await fetchRemoteBuffer(pdfUrl);
    res.setHeader('Content-Type', contentType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="contract-${property.propertyCode || property.id}.pdf"`,
    );
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    return fail(res, `Could not fetch contract PDF — ${err.message}`, 500);
  }
};

// Stream the owner's onboarding contract PDF for inline preview / download.
const downloadContractPdf = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...ownedPropertyScope(req) },
    include: [{ model: Contract, as: 'contract' }],
  });
  if (!property) return fail(res, 'Property not found', 404);
  return streamContractPdf(property, res);
});

// Code-keyed variant — used by the auditor-linked owner pages which only
// know the propertyCode (not the numeric id).
const downloadContractPdfByCode = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { propertyCode: req.params.code, ...ownedPropertyScope(req) },
    include: [{ model: Contract, as: 'contract' }],
  });
  if (!property) return fail(res, 'Property not found', 404);
  return streamContractPdf(property, res);
});

// ─────────────────────────────────────────────────────────────────────────
// Owner self-onboarding endpoints
//
// Mirror the auditor's Phase 1 → 2 → 3 → 4 → submit lifecycle, but with
// `source = 'self'` and no auditorId. The officer reviews these properties
// in the same dashboard; after final approval the officer uploads and routes
// the contract directly with the owner.
// ─────────────────────────────────────────────────────────────────────────

const createSelfProperty = asyncHandler(async (req, res) => {
  const {
    name, address, locationText, latitude, longitude,
    numberOfRooms,
  } = req.body;
  if (!name?.trim() || !address?.trim()) {
    return fail(res, 'Name and address are required', 400);
  }
  if (!latitude || !longitude) {
    return fail(res, 'Pinned current location is required', 400);
  }
  const owner = req.pwaUser;
  const property = await Property.create({
    auditorId: null,
    ownerId: owner.id,
    source: 'self',
    name: name.trim(),
    address: address.trim(),
    locationMode: 'pinned',
    locationText: locationText?.trim() || address.trim(),
    latitude,
    longitude,
    ownerName: owner.name || 'Owner',
    ownerEmail: owner.email,
    ownerPhone: owner.phone || null,
    numberOfRooms: numberOfRooms ? parseInt(numberOfRooms, 10) : null,
    status: PROPERTY_STATUS.PHASE1_DONE,
    phase: 2,
  });
  return created(res, { property }, 'Phase 1 saved');
});

const generateSelfId = asyncHandler(async (req, res) => {
  const property = await loadOwnedProperty(req, { id: req.params.id, source: 'self' });
  if (!property) return fail(res, 'Property not found', 404);
  if (property.propertyCode) {
    return ok(res, { property }, 'Property ID already generated');
  }
  property.propertyCode = await generatePropertyCode();
  property.phase = 3;
  await property.save();
  return ok(res, { property }, 'Property ID generated');
});

// Mirrors auditor's upsertSection — accepts photos + description, snapshots
// previous version into photoHistory on revision, resets the review row.
const upsertSelfSection = asyncHandler(async (req, res) => {
  const property = await loadOwnedProperty(req, { id: req.params.id, source: 'self' });
  if (!property) return fail(res, 'Property not found', 404);
  if (!property.propertyCode) {
    return fail(res, 'Generate the Property ID first', 400);
  }
  const sectionKey = req.params.sectionKey;
  if (!SECTION_KEY_SET.has(sectionKey)) return fail(res, 'Invalid section', 400);

  const incomingPhotos = (req.files || []).map(getUploadedUrl).filter(Boolean);
  const description = req.body.description ?? null;
  const replacePhotos = req.body.replacePhotos === 'true';
  const removeUrls = req.body.removeUrls
    ? String(req.body.removeUrls).split(',').filter(Boolean)
    : [];

  let deepDiveData = null;
  if (req.body.deepDiveData !== undefined && req.body.deepDiveData !== '') {
    try {
      deepDiveData = typeof req.body.deepDiveData === 'string'
        ? JSON.parse(req.body.deepDiveData)
        : req.body.deepDiveData;
      if (deepDiveData && typeof deepDiveData !== 'object') deepDiveData = null;
    } catch {
      return fail(res, 'deepDiveData must be valid JSON', 400);
    }
  }

  let field = await PropertyField.findOne({
    where: { propertyId: property.id, sectionKey },
  });
  const existingReview = await FieldReview.findOne({
    where: { propertyId: property.id, sectionKey },
  });

  const existingPhotos = field?.photoUrls || [];
  const kept = replacePhotos
    ? []
    : existingPhotos.filter((u) => !removeUrls.includes(u));
  const wasRejected = existingReview?.decision === FIELD_DECISION.REJECTED;
  const isRevision = field && (property.status === PROPERTY_STATUS.IN_REVISION || wasRejected);
  if (!isRevision) {
    if (!replacePhotos) {
      removeUrls.forEach((u) => removeUploadedFile(u));
    } else {
      existingPhotos.forEach((u) => removeUploadedFile(u));
    }
  }

  const merged = [...kept, ...incomingPhotos];
  const minimumPhotos = minPhotosForSection(property, sectionKey);
  if (merged.length < minimumPhotos) {
    incomingPhotos.forEach((u) => removeUploadedFile(u));
    return fail(res, `${minimumPhotos} photos are required for this section`, 400);
  }

  if (!field) {
    field = await PropertyField.create({
      propertyId: property.id,
      sectionKey,
      description,
      photoUrls: merged,
      iteration: 1,
      photoHistory: [],
      deepDiveData: deepDiveData || {},
      updatedByAuditorAt: new Date(),
    });
  } else {
    if (isRevision) {
      const history = Array.isArray(field.photoHistory) ? [...field.photoHistory] : [];
      history.push({
        iteration: field.iteration,
        photoUrls: existingPhotos,
        description: field.description || null,
        deepDiveData: field.deepDiveData || null,
        snapshotAt: field.updatedByAuditorAt || field.updatedAt || new Date(),
        reviewComment: wasRejected ? existingReview?.comment || null : null,
      });
      field.photoHistory = history;
      field.iteration += 1;
    }
    field.description = description ?? field.description;
    field.photoUrls = merged;
    if (deepDiveData !== null) field.deepDiveData = deepDiveData;
    field.updatedByAuditorAt = new Date();
    await field.save();
  }

  if (existingReview) {
    existingReview.decision = FIELD_DECISION.PENDING;
    existingReview.comment = null;
    existingReview.approvedForFutureReview = false;
    existingReview.reviewedAt = null;
    await existingReview.save();
  }

  emitToProperty(property.id, 'property:field-updated', {
    propertyId: property.id,
    sectionKey,
    field,
    review: existingReview,
  });

  if (isRevision && property.assignedOfficerId) {
    const sectionLabel =
      SECTION_KEYS.find((s) => s.key === sectionKey)?.label || sectionKey;
    notifyUser({
      role: 'officer',
      userId: property.assignedOfficerId,
      type: 'section_reupload',
      title: `Re-uploaded: ${sectionLabel}`,
      body: `Owner updated ${property.propertyCode || property.name} — please re-review.`,
      propertyId: property.id,
      data: { sectionKey, iteration: field.iteration, source: 'self' },
    });
  }

  return ok(res, { field, review: existingReview }, 'Section saved');
});

const submitSelfForReview = asyncHandler(async (req, res) => {
  const property = await loadOwnedProperty(req, { id: req.params.id, source: 'self' });
  if (!property) return fail(res, 'Property not found', 404);
  if (!property.propertyCode) return fail(res, 'Generate the Property ID first', 400);

  const fields = await PropertyField.findAll({ where: { propertyId: property.id } });
  const byKey = Object.fromEntries(fields.map((f) => [f.sectionKey, f]));
  const missing = SECTION_KEYS
    .filter((s) => s.required)
    .filter((s) => {
      const f = byKey[s.key];
      if (s.key === 'rooms') return !roomsSectionComplete(property, f);
      return !f || !f.description?.trim() || (f.photoUrls || []).length < minPhotosForSection(property, s.key);
    })
    .map((s) => s.label);
  if (missing.length) {
    return fail(res, `Missing required sections: ${missing.join(', ')}`, 400);
  }

  for (const f of fields) {
    const review = await FieldReview.findOne({
      where: { propertyId: property.id, sectionKey: f.sectionKey },
    });
    if (!review) {
      await FieldReview.create({
        propertyId: property.id,
        sectionKey: f.sectionKey,
        decision: FIELD_DECISION.PENDING,
      });
    }
  }

  // Same round-robin assignment as the auditor flow so officer workload
  // stays balanced.
  if (!property.assignedOfficerId) {
    const officers = await Officer.findAll({
      where: { isActive: true },
      attributes: ['id'],
    });
    if (officers.length) {
      const counts = await Property.findAll({
        attributes: [
          'assignedOfficerId',
          [require('sequelize').fn('COUNT', '*'), 'cnt'],
        ],
        where: {
          assignedOfficerId: officers.map((o) => o.id),
          status: [
            PROPERTY_STATUS.PHASE3_SUBMITTED,
            PROPERTY_STATUS.IN_REVIEW,
            PROPERTY_STATUS.IN_REVISION,
          ],
        },
        group: ['assignedOfficerId'],
        raw: true,
      });
      const countMap = Object.fromEntries(counts.map((c) => [c.assignedOfficerId, parseInt(c.cnt, 10)]));
      const pick = officers
        .map((o) => ({ id: o.id, n: countMap[o.id] || 0 }))
        .sort((a, b) => a.n - b.n)[0];
      property.assignedOfficerId = pick.id;
    }
  }

  property.status = property.status === PROPERTY_STATUS.IN_REVISION
    ? PROPERTY_STATUS.IN_REVISION
    : PROPERTY_STATUS.PHASE3_SUBMITTED;
  property.submittedAt = new Date();
  await property.save();

  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
  });
  if (property.assignedOfficerId) {
    notifyUser({
      role: 'officer',
      userId: property.assignedOfficerId,
      type: 'property_submitted',
      title: `Self-onboarded: ${property.propertyCode || property.name}`,
      body: 'Owner submitted Phase 3 for your review.',
      propertyId: property.id,
      data: { source: 'self' },
    });
  }

  const full = await loadOwnedProperty(req, { id: property.id, source: 'self' });
  return ok(res, { property: full }, 'Submitted for review');
});

// -- Owner Phase 4 mirrors the auditor flow -----------------------------

const getSelfPhase4 = asyncHandler(async (req, res) => {
  const property = await loadOwnedProperty(req, { id: req.params.id, source: 'self' });
  if (!property) return fail(res, 'Property not found', 404);
  const rows = await PropertyPhase4Data.findAll({ where: { propertyId: property.id } });
  const data = {};
  SECTION_KEYS.forEach((s) => { data[s.key] = rows.find((r) => r.sectionKey === s.key) || null; });
  return ok(res, {
    property: {
      id: property.id, name: property.name, propertyCode: property.propertyCode,
      status: property.status, phase4SubmittedAt: property.phase4SubmittedAt,
    },
    sections: SECTION_KEYS,
    schema: PHASE4_SCHEMA,
    data,
  });
});

const phase4Eligible = new Set([
  PROPERTY_STATUS.APPROVED, PROPERTY_STATUS.PHASE4_SUBMITTED, PROPERTY_STATUS.PHASE4_IN_REVISION,
]);

const sanitisePhase4 = (sectionKey, raw) => {
  if (!PHASE4_FIELD_KEYS[sectionKey]) throw `Unknown Phase 4 section "${sectionKey}"`;
  if (raw === null || typeof raw !== 'object') throw 'data must be an object';
  const allowed = PHASE4_FIELD_KEYS[sectionKey];
  const schemaByKey = Object.fromEntries(PHASE4_SCHEMA[sectionKey].map((f) => [f.key, f]));
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) continue;
    const field = schemaByKey[k];
    if (v === '' || v === undefined || v === null) { cleaned[k] = null; continue; }
    if (field.type === 'bool') cleaned[k] = v === true || v === 'true' || v === 1 || v === '1';
    else if (field.type === 'number') { const n = Number(v); cleaned[k] = Number.isFinite(n) ? n : null; }
    else if (field.type === 'multi') {
      const arr = Array.isArray(v) ? v : String(v).split(',');
      cleaned[k] = arr.map((x) => String(x).trim()).filter(Boolean)
        .filter((x) => !field.options || field.options.includes(x));
    } else if (field.type === 'select') {
      const s = String(v).trim();
      cleaned[k] = field.options?.includes(s) ? s : null;
    } else cleaned[k] = String(v);
  }
  return cleaned;
};

const upsertSelfPhase4Section = asyncHandler(async (req, res) => {
  const { id, sectionKey } = req.params;
  if (!SECTION_KEY_SET.has(sectionKey)) return fail(res, 'Invalid section', 400);
  const property = await loadOwnedProperty(req, { id, source: 'self' });
  if (!property) return fail(res, 'Property not found', 404);
  if (!phase4Eligible.has(property.status)) {
    return fail(res, 'Phase 4 is not available for this property yet', 400);
  }
  let cleaned;
  try { cleaned = sanitisePhase4(sectionKey, req.body.data || {}); }
  catch (msg) { return fail(res, msg, 400); }

  const [row, justCreated] = await PropertyPhase4Data.findOrCreate({
    where: { propertyId: property.id, sectionKey },
    defaults: { data: cleaned, status: 'pending', updatedByAuditorAt: new Date() },
  });
  if (!justCreated) {
    const wasRejected = row.status === 'rejected';
    row.data = cleaned;
    row.updatedByAuditorAt = new Date();
    if (wasRejected) {
      row.status = 'pending';
      row.feedback = null;
      row.iteration = (row.iteration || 1) + 1;
    }
    await row.save();
  }
  return ok(res, { section: row }, 'Section saved');
});

const submitSelfPhase4 = asyncHandler(async (req, res) => {
  const property = await loadOwnedProperty(req, { id: req.params.id, source: 'self' });
  if (!property) return fail(res, 'Property not found', 404);
  if (!phase4Eligible.has(property.status)) {
    return fail(res, 'Phase 4 is not available yet', 400);
  }
  const rows = await PropertyPhase4Data.findAll({ where: { propertyId: property.id } });
  if (rows.length === 0) return fail(res, 'Fill at least one section first', 400);
  const filled = new Set(rows.map((r) => r.sectionKey));
  const missing = SECTION_KEYS.filter((s) => s.required && !filled.has(s.key));
  if (missing.length) {
    return fail(res, `Required sections still empty: ${missing.map((m) => m.label).join(', ')}`, 400);
  }

  property.status = PROPERTY_STATUS.PHASE4_SUBMITTED;
  property.phase4SubmittedAt = new Date();
  await property.save();
  await PropertyPhase4Data.update(
    { status: 'pending', feedback: null },
    { where: { propertyId: property.id, status: { [Op.ne]: 'approved' } } },
  );

  emitToProperty(property.id, 'property:status', { propertyId: property.id, status: property.status });
  if (property.assignedOfficerId) {
    notifyUser({
      role: 'officer',
      userId: property.assignedOfficerId,
      type: 'phase4_submitted',
      title: `Phase 4 submitted: ${property.propertyCode || property.name}`,
      body: 'Self-onboarded owner submitted Phase 4 deep-dive.',
      propertyId: property.id,
      data: { source: 'self' },
    });
  }
  return ok(res, { property }, 'Phase 4 submitted for review');
});

// -- Availability lead endpoints (Check-Availability flow) ---------------

const leadInclude = () => [
  { model: Package, as: 'package', attributes: ['id', 'name', 'slug', 'primaryImage', 'priceFrom', 'currency', 'durationDays', 'durationNights'] },
  { model: Salesperson, as: 'salesperson', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
];

const listMyLeads = asyncHandler(async (req, res) => {
  const items = await AvailabilityLead.findAll({
    where: { ownerId: req.pwaUser.id },
    include: leadInclude(),
    order: [['createdAt', 'DESC']],
  });
  return ok(res, { items });
});

const respondToLead = asyncHandler(async (req, res) => {
  const { decision, note } = req.body;
  if (!['yes', 'no'].includes(decision)) return fail(res, 'decision must be yes or no', 400);

  const lead = await AvailabilityLead.findOne({
    where: { id: req.params.leadId, ownerId: req.pwaUser.id },
  });
  if (!lead) return fail(res, 'Lead not found', 404);
  if (lead.status !== 'pending') {
    return fail(res, `Lead already responded to (${lead.status})`, 400);
  }

  lead.status = decision === 'yes' ? 'owner_yes' : 'owner_no';
  lead.ownerRespondedAt = new Date();
  lead.ownerNote = note?.trim() || null;
  await lead.save();

  const fresh = await AvailabilityLead.findByPk(lead.id, { include: leadInclude() });
  return ok(res, { lead: fresh }, `Marked as ${decision === 'yes' ? 'available' : 'not available'}`);
});

// Standalone per-photo helper for the owner-self rooms section editor.
// Same intent as the auditor's upload-one — eager upload returns a URL
// that the editor stores in deepDiveData.rooms[i].photos[cat].
const uploadOneSelfPhoto = asyncHandler(async (req, res) => {
  if (!req.file) return fail(res, 'No file', 400);
  const url = getUploadedUrl(req.file);
  if (!url) return fail(res, 'Could not store file', 500);
  return ok(res, { url });
});

module.exports = {
  listMyProperties,
  getOneByCode,
  getOneById,
  uploadSignedContract,
  uploadSignedContractById,
  downloadContractPdf,
  downloadContractPdfByCode,
  createSelfProperty,
  generateSelfId,
  upsertSelfSection,
  submitSelfForReview,
  uploadOneSelfPhoto,
  getSelfPhase4,
  upsertSelfPhase4Section,
  submitSelfPhase4,
  listMyLeads,
  respondToLead,
};

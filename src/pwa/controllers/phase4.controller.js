const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { Property, PropertyPhase4Data, Auditor } = require('../models');
const { ok, fail } = require('../../utils/response');
const { emitToProperty } = require('../services/socket');
const { notifyUser } = require('../services/notifications');
const { send } = require('../services/mailer');
const {
  SECTION_KEYS, SECTION_KEY_SET,
  PHASE4_SCHEMA, PHASE4_FIELD_KEYS,
  PROPERTY_STATUS,
} = require('../constants');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// A property must have completed Phase 3 (status `approved` or further along)
// before Phase 4 can be opened or worked on.
const PHASE4_ELIGIBLE_STATUSES = new Set([
  PROPERTY_STATUS.APPROVED,
  PROPERTY_STATUS.PHASE4_SUBMITTED,
  PROPERTY_STATUS.PHASE4_IN_REVISION,
]);

const loadAuditorOwnProperty = async (auditorId, id) =>
  Property.findOne({
    where: { id, auditorId },
    include: [{ model: PropertyPhase4Data, as: 'phase4' }],
  });

const officerVisibility = (officerId) => ({
  [Op.or]: [
    { assignedOfficerId: officerId },
    { assignedOfficerId: null, status: PROPERTY_STATUS.PHASE4_SUBMITTED },
  ],
});

// Validate + sanitise incoming `data` against PHASE4_SCHEMA. Returns the
// cleaned object; throws a string on failure (caller turns it into a 400).
const sanitisePhase4Data = (sectionKey, raw) => {
  if (!PHASE4_FIELD_KEYS[sectionKey]) {
    throw `Unknown Phase 4 section "${sectionKey}"`;
  }
  if (raw === null || typeof raw !== 'object') {
    throw 'data must be an object';
  }
  const allowed = PHASE4_FIELD_KEYS[sectionKey];
  const schemaByKey = Object.fromEntries(
    PHASE4_SCHEMA[sectionKey].map((f) => [f.key, f]),
  );
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) continue;
    const field = schemaByKey[k];
    if (v === '' || v === undefined || v === null) { cleaned[k] = null; continue; }
    if (field.type === 'bool') {
      cleaned[k] = v === true || v === 'true' || v === 1 || v === '1';
    } else if (field.type === 'number') {
      const n = Number(v);
      cleaned[k] = Number.isFinite(n) ? n : null;
    } else if (field.type === 'multi') {
      const arr = Array.isArray(v) ? v : String(v).split(',');
      cleaned[k] = arr
        .map((x) => String(x).trim())
        .filter(Boolean)
        .filter((x) => !field.options || field.options.includes(x));
    } else if (field.type === 'select') {
      const s = String(v).trim();
      cleaned[k] = field.options?.includes(s) ? s : null;
    } else {
      cleaned[k] = String(v);
    }
  }
  return cleaned;
};

const groupBySection = (rows) => {
  const out = {};
  SECTION_KEYS.forEach((s) => {
    out[s.key] = rows.find((r) => r.sectionKey === s.key) || null;
  });
  return out;
};

// ────────────────────────────────────────────────────────────────────────────
// Auditor — fill Phase 4 deep-dive sections for one of their own properties.
// ────────────────────────────────────────────────────────────────────────────

// GET /api/pwa/auditor/properties/:id/phase4
const getForAuditor = asyncHandler(async (req, res) => {
  const property = await loadAuditorOwnProperty(req.pwaUser.id, req.params.id);
  if (!property) return fail(res, 'Property not found', 404);

  return ok(res, {
    property: {
      id: property.id,
      name: property.name,
      propertyCode: property.propertyCode,
      status: property.status,
      phase4SubmittedAt: property.phase4SubmittedAt,
    },
    sections: SECTION_KEYS,
    schema: PHASE4_SCHEMA,
    data: groupBySection(property.phase4 || []),
  });
});

// PUT /api/pwa/auditor/properties/:id/phase4/:sectionKey
const upsertSection = asyncHandler(async (req, res) => {
  const { id, sectionKey } = req.params;
  if (!SECTION_KEY_SET.has(sectionKey)) return fail(res, 'Invalid section', 400);

  const property = await loadAuditorOwnProperty(req.pwaUser.id, id);
  if (!property) return fail(res, 'Property not found', 404);
  if (!PHASE4_ELIGIBLE_STATUSES.has(property.status)) {
    return fail(res, 'Phase 4 is not available for this property yet', 400);
  }

  let cleaned;
  try {
    cleaned = sanitisePhase4Data(sectionKey, req.body.data || {});
  } catch (msg) {
    return fail(res, msg, 400);
  }

  const [row, created] = await PropertyPhase4Data.findOrCreate({
    where: { propertyId: property.id, sectionKey },
    defaults: { data: cleaned, status: 'pending', updatedByAuditorAt: new Date() },
  });

  if (!created) {
    const wasRejected = row.status === 'rejected';
    row.data = cleaned;
    row.updatedByAuditorAt = new Date();
    // Re-uploads after officer rejection re-open the section + bump iteration.
    if (wasRejected) {
      row.status = 'pending';
      row.feedback = null;
      row.iteration = (row.iteration || 1) + 1;
    }
    await row.save();
  }

  return ok(res, { section: row }, 'Section saved');
});

// POST /api/pwa/auditor/properties/:id/phase4/submit
const submitForReview = asyncHandler(async (req, res) => {
  const property = await loadAuditorOwnProperty(req.pwaUser.id, req.params.id);
  if (!property) return fail(res, 'Property not found', 404);
  if (!PHASE4_ELIGIBLE_STATUSES.has(property.status)) {
    return fail(res, 'Phase 4 is not available for this property yet', 400);
  }

  const sections = await PropertyPhase4Data.findAll({ where: { propertyId: property.id } });
  if (sections.length === 0) {
    return fail(res, 'Fill at least one section before submitting', 400);
  }
  // Auditor must have at least filled every REQUIRED section in SECTION_KEYS.
  const filled = new Set(sections.map((s) => s.sectionKey));
  const missing = SECTION_KEYS.filter((s) => s.required && !filled.has(s.key));
  if (missing.length > 0) {
    return fail(
      res,
      `Required sections still empty: ${missing.map((m) => m.label).join(', ')}`,
      400,
    );
  }

  property.status = PROPERTY_STATUS.PHASE4_SUBMITTED;
  property.phase4SubmittedAt = new Date();
  await property.save();

  // Mark every section pending again so the officer reviews afresh.
  await PropertyPhase4Data.update(
    { status: 'pending', feedback: null },
    { where: { propertyId: property.id, status: { [Op.ne]: 'approved' } } },
  );

  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
  });

  if (property.assignedOfficerId) {
    notifyUser({
      role: 'officer',
      userId: property.assignedOfficerId,
      type: 'phase4_submitted',
      title: `Phase 4 submitted: ${property.propertyCode || property.name}`,
      body: 'Deep-dive ready for your review.',
      propertyId: property.id,
    });
  }

  return ok(res, { property }, 'Phase 4 submitted to centralize for review');
});

// ────────────────────────────────────────────────────────────────────────────
// Officer — review Phase 4 sections; final-approve property.
// ────────────────────────────────────────────────────────────────────────────

// GET /api/pwa/officer/phase4/:id
const getForOfficer = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...officerVisibility(req.pwaUser.id) },
    include: [
      { model: PropertyPhase4Data, as: 'phase4' },
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);

  return ok(res, {
    property,
    sections: SECTION_KEYS,
    schema: PHASE4_SCHEMA,
    data: groupBySection(property.phase4 || []),
  });
});

// POST /api/pwa/officer/phase4/:id/sections/:sectionKey/decide
//   body: { decision: 'approved' | 'rejected', feedback? }
const decideSection = asyncHandler(async (req, res) => {
  const { id, sectionKey } = req.params;
  const { decision, feedback } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    return fail(res, 'decision must be "approved" or "rejected"', 400);
  }
  if (decision === 'rejected' && !feedback?.trim()) {
    return fail(res, 'Feedback is required for rejection', 400);
  }

  const property = await Property.findOne({
    where: { id, ...officerVisibility(req.pwaUser.id) },
  });
  if (!property) return fail(res, 'Property not found', 404);

  const row = await PropertyPhase4Data.findOne({
    where: { propertyId: property.id, sectionKey },
  });
  if (!row) return fail(res, 'Section not yet filled by auditor', 400);

  row.status = decision;
  row.feedback = decision === 'rejected' ? feedback.trim() : null;
  row.reviewedByOfficerAt = new Date();
  row.reviewedByOfficerId = req.pwaUser.id;
  await row.save();

  // Claim the property if unassigned.
  if (!property.assignedOfficerId) {
    property.assignedOfficerId = req.pwaUser.id;
    await property.save();
  }

  return ok(res, { section: row }, `Section ${decision}`);
});

// POST /api/pwa/officer/phase4/:id/send-back
//   Send the whole submission back to the auditor for revision (when at
//   least one section was rejected). Bulk action — flips status to
//   PHASE4_IN_REVISION and emits a socket event.
const sendBackForRevision = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...officerVisibility(req.pwaUser.id) },
  });
  if (!property) return fail(res, 'Property not found', 404);

  const sections = await PropertyPhase4Data.findAll({
    where: { propertyId: property.id },
  });
  const hasRejected = sections.some((s) => s.status === 'rejected');
  if (!hasRejected) {
    return fail(res, 'Mark at least one section rejected before sending back', 400);
  }

  property.status = PROPERTY_STATUS.PHASE4_IN_REVISION;
  property.assignedOfficerId = property.assignedOfficerId || req.pwaUser.id;
  await property.save();

  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
  });
  // Route the ping to whoever actually owns Phase 4 — auditor for
  // auditor-onboarded, owner for self-onboarded.
  if (property.source === 'self' && property.ownerId) {
    notifyUser({
      role: 'owner',
      userId: property.ownerId,
      type: 'phase4_revision',
      title: `Phase 4 sent back: ${property.propertyCode || property.name}`,
      body: 'One or more sections need revision.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  } else if (property.auditorId) {
    notifyUser({
      role: 'auditor',
      userId: property.auditorId,
      type: 'phase4_revision',
      title: `Phase 4 sent back: ${property.propertyCode || property.name}`,
      body: 'One or more sections need revision.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }
  return ok(res, { property }, 'Sent back to auditor for revision');
});

// POST /api/pwa/officer/phase4/:id/final-approve
//   All Phase 4 sections must be 'approved'. Flips status to
//   FINAL_APPROVED and triggers contract PDF generation — from there the
//   Task 3 flow takes over (auditor releases to owner).
const finalApprove = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...officerVisibility(req.pwaUser.id) },
    include: [
      { model: Auditor, as: 'auditor' },
      { model: PropertyPhase4Data, as: 'phase4' },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);

  const sections = property.phase4 || [];
  // Every REQUIRED section must exist and be approved.
  for (const cat of SECTION_KEYS) {
    if (!cat.required) continue;
    const row = sections.find((r) => r.sectionKey === cat.key);
    if (!row) return fail(res, `Phase 4 missing required section "${cat.label}"`, 400);
    if (row.status !== 'approved') {
      return fail(res, `Phase 4 section "${cat.label}" is not approved yet`, 400);
    }
  }
  // Any optional sections that exist must also be decided, not pending.
  const pending = sections.find((s) => s.status === 'pending');
  if (pending) {
    return fail(res, 'Some Phase 4 sections are still pending review', 400);
  }

  property.status = PROPERTY_STATUS.FINAL_APPROVED;
  property.finalApprovedAt = new Date();
  property.assignedOfficerId = property.assignedOfficerId || req.pwaUser.id;
  await property.save();

  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
  });

  if (property.auditorId) {
    if (property.auditor?.email) {
      try {
        await send({
          to: property.auditor.email,
          subject: `Property approved: ${property.name} (${property.propertyCode || property.id})`,
          html: `
            <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
              <h2 style="margin:0 0 12px;color:#0f766e;">Property approved</h2>
              <p style="color:#374151;line-height:1.55;">
                The central officer has approved <strong>${property.name}</strong>.
                You can now upload the contract PDF and send it to the property owner for e-signing.
              </p>
              <div style="font-size:18px;font-weight:700;letter-spacing:2px;background:#f0fdfa;padding:14px 18px;text-align:center;border-radius:10px;color:#0f766e;margin:18px 0;">
                Property ID: ${property.propertyCode || property.id}
              </div>
            </div>
          `,
          text: `Property approved: ${property.name}. You can now upload the contract PDF and send it to the owner for e-signing.`,
        });
      } catch (err) {
        console.warn('[PWA] auditor approval email failed:', err.message);
      }
    }
    notifyUser({
      role: 'auditor',
      userId: property.auditorId,
      type: 'property_approved',
      title: `Final approved: ${property.propertyCode || property.name}`,
      body: 'Property approved. You can now upload the contract PDF and send it to the owner for e-signing.',
      propertyId: property.id,
    });
  }
  if (property.ownerId) {
    notifyUser({
      role: 'owner',
      userId: property.ownerId,
      type: 'property_approved',
      title: `Final approved: ${property.propertyCode || property.name}`,
      body: 'The central officer will upload the contract for your signature.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode },
    });
  }

  return ok(res, { property }, property.source === 'self'
    ? 'Final approved. Upload the contract from Contracts.'
    : 'Final approved. Auditor can now send the contract for e-sign.');
});

module.exports = {
  // auditor
  getForAuditor,
  upsertSection,
  submitForReview,
  // officer
  getForOfficer,
  decideSection,
  sendBackForRevision,
  finalApprove,
};

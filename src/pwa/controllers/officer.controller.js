const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  Property,
  PropertyField,
  FieldReview,
  Contract,
  Auditor,
  PwaListingConfig,
} = require('../models');
const { ok, fail } = require('../../utils/response');
const { getUploadedUrl } = require('../../utils/uploads');
const { emitToProperty } = require('../services/socket');
const { notifyUser } = require('../services/notifications');
const { send, sendContract } = require('../services/mailer');
const { emailShell, calloutBox } = require('../../utils/emailLayout');
const { SECTION_KEY_SET, PROPERTY_STATUS, FIELD_DECISION } = require('../constants');

// All routes here use authenticatePwa + requireRoles('officer') in the
// router. We additionally scope every query to the officer's own id once a
// property has been assigned, but leave unassigned-but-submitted properties
// visible (so officers can "claim" new ones).

const propertyInclude = () => [
  { model: PropertyField, as: 'fields' },
  { model: FieldReview, as: 'reviews' },
  { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'phone', 'profilePhotoUrl'] },
  { model: Contract, as: 'contract' },
];

const contractFilename = (property, suffix = 'contract') =>
  `${suffix}-${property.propertyCode || property.id}.pdf`;

const getOrCreateContract = async (propertyId) => {
  let contract = await Contract.findOne({ where: { propertyId } });
  if (!contract) contract = await Contract.create({ propertyId });
  return contract;
};

const visibilityFilter = (officerId) => ({
  [Op.or]: [
    { assignedOfficerId: officerId },
    {
      assignedOfficerId: null,
      status: [PROPERTY_STATUS.PHASE3_SUBMITTED, PROPERTY_STATUS.PHASE4_SUBMITTED],
    },
  ],
});

// --- Tabs --------------------------------------------------------------

const listProperties = asyncHandler(async (req, res) => {
  const { tab = 'new' } = req.query;
  const officerId = req.pwaUser.id;

  let where = { ...visibilityFilter(officerId) };
  if (tab === 'new') {
    where.status = [PROPERTY_STATUS.PHASE3_SUBMITTED, PROPERTY_STATUS.IN_REVIEW];
  } else if (tab === 'phase4') {
    // Phase 4 deep-dive submissions awaiting officer review.
    where.status = [PROPERTY_STATUS.PHASE4_SUBMITTED];
  } else if (tab === 'follow-up') {
    where.status = [PROPERTY_STATUS.IN_REVISION, PROPERTY_STATUS.PHASE4_IN_REVISION];
    where.assignedOfficerId = officerId; // only mine
  } else if (tab === 'rejected') {
    where.status = [PROPERTY_STATUS.REJECTED];
    where.assignedOfficerId = officerId;
  } else if (tab === 'approved') {
    where.status = [
      PROPERTY_STATUS.APPROVED,
      PROPERTY_STATUS.PHASE4_SUBMITTED,
      PROPERTY_STATUS.PHASE4_IN_REVISION,
      PROPERTY_STATUS.FINAL_APPROVED,
      PROPERTY_STATUS.CONTRACT_SENT,
      PROPERTY_STATUS.CONTRACT_SIGNED,
      PROPERTY_STATUS.COMPLETED,
    ];
    where.assignedOfficerId = officerId;
  } else if (tab === 'all') {
    where.assignedOfficerId = officerId;
  }

  const items = await Property.findAll({
    where,
    include: [
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email', 'profilePhotoUrl'] },
      { model: FieldReview, as: 'reviews' },
    ],
    order: [['submittedAt', 'DESC'], ['updatedAt', 'DESC']],
  });
  return ok(res, { items });
});

const getProperty = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
    include: propertyInclude(),
  });
  if (!property) return fail(res, 'Property not found', 404);
  return ok(res, { property });
});

// --- Claim a new property (auto-assign current officer) ----------------

const claim = asyncHandler(async (req, res) => {
  const property = await Property.findByPk(req.params.id);
  if (!property) return fail(res, 'Property not found', 404);
  if (property.assignedOfficerId && property.assignedOfficerId !== req.pwaUser.id) {
    return fail(res, 'Another officer is already on this case', 409);
  }
  property.assignedOfficerId = req.pwaUser.id;
  if (property.status === PROPERTY_STATUS.PHASE3_SUBMITTED) {
    property.status = PROPERTY_STATUS.IN_REVIEW;
  }
  await property.save();
  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
    assignedOfficerId: property.assignedOfficerId,
  });
  return ok(res, { property }, 'Claimed');
});

// --- Field-level decision (green/red) ----------------------------------

const decideField = asyncHandler(async (req, res) => {
  const { id: propertyId, sectionKey } = req.params;
  const { decision, comment, approvedForFutureReview } = req.body;
  if (!SECTION_KEY_SET.has(sectionKey)) return fail(res, 'Invalid section', 400);
  if (![FIELD_DECISION.APPROVED, FIELD_DECISION.REJECTED].includes(decision)) {
    return fail(res, 'decision must be approved or objection', 400);
  }
  if (decision === FIELD_DECISION.REJECTED && !comment?.trim()) {
    return fail(res, 'Raising an objection requires a comment', 400);
  }
  if (
    decision === FIELD_DECISION.APPROVED &&
    approvedForFutureReview === true &&
    !comment?.trim()
  ) {
    return fail(res, 'Approving with objection requires a note', 400);
  }

  const property = await Property.findOne({
    where: { id: propertyId, ...visibilityFilter(req.pwaUser.id) },
  });
  if (!property) return fail(res, 'Property not found', 404);

  // Officer auto-claims on first review action.
  if (!property.assignedOfficerId) {
    property.assignedOfficerId = req.pwaUser.id;
  }
  if (property.status === PROPERTY_STATUS.PHASE3_SUBMITTED) {
    property.status = PROPERTY_STATUS.IN_REVIEW;
  }

  const [review] = await FieldReview.findOrCreate({
    where: { propertyId: property.id, sectionKey },
    defaults: { decision: FIELD_DECISION.PENDING },
  });
  review.decision = decision;
  const approveWithObjection =
    decision === FIELD_DECISION.APPROVED && approvedForFutureReview === true;
  if (decision === FIELD_DECISION.REJECTED) {
    review.comment = comment.trim();
  } else if (approveWithObjection) {
    review.comment = comment.trim();
  } else {
    review.comment = null;
  }
  review.approvedForFutureReview = approveWithObjection;
  review.officerId = req.pwaUser.id;
  review.reviewedAt = new Date();
  await review.save();

  // If anything has an objection, parent property moves to in_revision so the
  // auditor sees objections on their dashboard. If everything is approved
  // and at least every required section is decided, we stay in_review
  // until the officer hits the final approve action.
  if (decision === FIELD_DECISION.REJECTED) {
    property.status = PROPERTY_STATUS.IN_REVISION;
  }
  await property.save();

  emitToProperty(property.id, 'property:field-review', {
    propertyId: property.id,
    sectionKey,
    review,
    status: property.status,
  });

  // Notify whoever is responsible for fixing the section. For auditor-
  // onboarded properties that's the auditor; for self-onboarded ones it's
  // the owner directly. Notification carries `sectionKey` + `propertyCode`
  // so the client can deep-link to the exact section editor.
  const sectionLabel = (
    require('../constants').SECTION_KEYS.find((s) => s.key === sectionKey)?.label
    || sectionKey
  );
  const notifType = decision === FIELD_DECISION.REJECTED
    ? 'section_objection'
    : approveWithObjection
      ? 'section_approved_objection'
      : 'section_approved';
  const notifTitle = decision === FIELD_DECISION.REJECTED
    ? `Objection on ${sectionLabel}`
    : approveWithObjection
      ? `Approved with a note: ${sectionLabel}`
      : `Approved: ${sectionLabel}`;
  const notifBody = review.comment || `Property ${property.propertyCode || `#${property.id}`}`;
  const notifData = {
    sectionKey,
    decision: review.decision,
    propertyCode: property.propertyCode,
    source: property.source,
  };

  if (property.source === 'self' && property.ownerId) {
    notifyUser({
      role: 'owner',
      userId: property.ownerId,
      type: notifType,
      title: notifTitle,
      body: notifBody,
      propertyId: property.id,
      data: notifData,
    });
  } else if (property.auditorId) {
    notifyUser({
      role: 'auditor',
      userId: property.auditorId,
      type: notifType,
      title: notifTitle,
      body: notifBody,
      propertyId: property.id,
      data: notifData,
    });
  }

  return ok(res, { review, status: property.status }, 'Decision recorded');
});

// --- Suggestion box (free-form) ----------------------------------------

const updateSuggestion = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
  });
  if (!property) return fail(res, 'Property not found', 404);
  property.officerSuggestion = req.body.suggestion?.trim() || null;
  if (!property.assignedOfficerId) property.assignedOfficerId = req.pwaUser.id;
  await property.save();
  emitToProperty(property.id, 'property:suggestion', {
    propertyId: property.id,
    suggestion: property.officerSuggestion,
  });
  return ok(res, { property });
});

// --- Keep in follow-up -------------------------------------------------

const followUpProperty = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
  });
  if (!property) return fail(res, 'Property not found', 404);
  if ([
    PROPERTY_STATUS.APPROVED,
    PROPERTY_STATUS.CONTRACT_SENT,
    PROPERTY_STATUS.CONTRACT_SIGNED,
    PROPERTY_STATUS.COMPLETED,
    PROPERTY_STATUS.REJECTED,
  ].includes(property.status)) {
    return fail(res, 'Finalized properties cannot move to follow-up', 400);
  }

  property.status = PROPERTY_STATUS.IN_REVISION;
  property.officerSuggestion = req.body.suggestion?.trim() || property.officerSuggestion;
  property.assignedOfficerId = property.assignedOfficerId || req.pwaUser.id;
  await property.save();

  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
    suggestion: property.officerSuggestion,
  });

  return ok(res, { property }, 'Moved to follow-up');
});

// --- Final approve (Phase 3 + deep-dive merged) ------------------------
//
// Phase 4 has been folded into Phase 3 — the structured "deep-dive" fields
// now live on each PropertyField.deepDiveData and are reviewed alongside
// the section's photos + notes. So this single approval IS the final
// approval: it flips status to FINAL_APPROVED and immediately generates
// the contract PDF, then for self-onboarded properties also emails it
// straight to the owner (matching the old Phase 4 finalApprove behaviour).

const approveProperty = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
    include: propertyInclude(),
  });
  if (!property) return fail(res, 'Property not found', 404);

  const reviews = await FieldReview.findAll({ where: { propertyId: property.id } });
  const hasRejected = reviews.some((r) => r.decision === FIELD_DECISION.REJECTED);
  const hasPending = reviews.some((r) => r.decision === FIELD_DECISION.PENDING);
  if (hasRejected) return fail(res, 'Cannot approve while any section has an objection', 400);
  if (hasPending) return fail(res, 'All sections must be marked approved before final approval', 400);

  property.status = PROPERTY_STATUS.FINAL_APPROVED;
  property.approvedAt = property.approvedAt || new Date();
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
          html: emailShell({
            preheader: `${property.name} has been approved`,
            bodyHtml: `
              <h2 style="margin:0 0 10px;color:#101828;font-size:19px;">Property approved</h2>
              <p style="color:#374151;line-height:1.6;margin:0;">
                The central officer has approved <strong>${property.name}</strong>.
                You can now upload the contract PDF and send it to the property owner for e-signing.
              </p>
              ${calloutBox('Property ID', property.propertyCode || property.id)}
            `,
          }),
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
      data: { propertyCode: property.propertyCode, source: property.source },
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
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }

  return ok(res, { property }, property.source === 'self'
    ? 'Final approved. Upload the contract from Contracts.'
    : 'Final approved. Auditor can now send the contract for e-sign.');
});

// --- Final reject ------------------------------------------------------

const rejectProperty = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
  });
  if (!property) return fail(res, 'Property not found', 404);
  const { reason } = req.body;
  if (!reason?.trim()) return fail(res, 'A rejection reason is required', 400);
  property.status = PROPERTY_STATUS.REJECTED;
  property.rejectedReason = reason.trim();
  property.assignedOfficerId = property.assignedOfficerId || req.pwaUser.id;
  await property.save();
  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
    rejectedReason: property.rejectedReason,
  });
  if (property.source === 'self' && property.ownerId) {
    notifyUser({
      role: 'owner',
      userId: property.ownerId,
      type: 'property_rejected',
      title: `Property rejected: ${property.propertyCode || property.name}`,
      body: property.rejectedReason,
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  } else if (property.auditorId) {
    notifyUser({
      role: 'auditor',
      userId: property.auditorId,
      type: 'property_rejected',
      title: `Property rejected: ${property.propertyCode || property.name}`,
      body: property.rejectedReason,
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }
  return ok(res, { property }, 'Property rejected');
});

const uploadInitialContract = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
    include: [
      { model: Contract, as: 'contract' },
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);
  if (property.status !== PROPERTY_STATUS.FINAL_APPROVED) {
    return fail(res, 'Contract can be uploaded only after final approval', 400);
  }
  if (property.source !== 'self') {
    return fail(res, 'Auditor-onboarded contracts are uploaded by the auditor', 400);
  }
  if (!req.file) return fail(res, 'Upload a contract PDF', 400);

  const url = getUploadedUrl(req.file);
  if (!url) return fail(res, 'Could not store contract', 500);

  const contract = await getOrCreateContract(property.id);
  contract.generatedPdfUrl = url;
  contract.generatedAt = new Date();
  contract.sentAt = null;
  contract.releasedByAuditorId = null;
  contract.signedPdfUrl = null;
  contract.signedAt = null;
  contract.ownerSignedByEmail = null;
  contract.finalPdfUrl = null;
  contract.finalSignedAt = null;
  contract.finalSignedByOfficerId = null;
  contract.finalSentToAuditorAt = null;
  await contract.save();

  if (property.source === 'self') {
    let emailDelivered = false;
    let emailError = null;
    try {
      await sendContract({
        to: property.ownerEmail,
        ownerName: property.ownerName,
        propertyName: property.name,
        propertyCode: property.propertyCode,
        pdfBuffer: req.file.emailAttachmentBuffer,
        pdfUrl: url,
        pdfFilename: contractFilename(property),
        subject: `Please e-sign contract for ${property.name} (${property.propertyCode})`,
        heading: 'Please e-sign your contract',
        instructions: 'The contract is attached as a PDF. Please digitally sign it, then upload the signed copy in your owner portal.',
      });
      emailDelivered = true;
    } catch (err) {
      emailError = err.message;
      console.warn('[PWA] owner contract email failed:', err.message);
    }
    contract.sentAt = new Date();
    await contract.save();
    property.status = PROPERTY_STATUS.CONTRACT_SENT;
    await property.save();

    if (property.ownerId) {
      notifyUser({
        role: 'owner',
        userId: property.ownerId,
        type: 'contract_sent_to_owner',
        title: `Contract sent: ${property.propertyCode || property.name}`,
        body: 'Check your email, e-sign the PDF, then upload it in your portal.',
        propertyId: property.id,
        data: { propertyCode: property.propertyCode, source: property.source },
      });
    }
    emitToProperty(property.id, 'property:status', { propertyId: property.id, status: property.status });
    return ok(
      res,
      { property, contract, emailDelivered, emailError },
      emailDelivered
        ? 'Contract sent to owner for signature'
        : 'Contract uploaded to owner portal. Email delivery failed.',
    );
  }

  if (property.auditorId) {
    notifyUser({
      role: 'auditor',
      userId: property.auditorId,
      type: 'contract_generated',
      title: `Contract ready for signature: ${property.propertyCode || property.name}`,
      body: 'Download the contract, sign it, and upload the signed copy back to the officer.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }
  emitToProperty(property.id, 'property:status', { propertyId: property.id, status: property.status });
  return ok(res, { property, contract }, 'Contract uploaded for auditor signature');
});

const uploadFinalContract = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
    include: [
      { model: Contract, as: 'contract' },
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);
  if (property.source !== 'self') {
    return fail(res, 'Auditor-onboarded contracts are completed by the auditor', 400);
  }
  if (!property.contract?.signedPdfUrl) {
    return fail(res, 'Signed copy from owner/auditor is required first', 400);
  }
  if (!req.file) return fail(res, 'Upload the officer-signed final contract PDF', 400);

  const url = getUploadedUrl(req.file);
  if (!url) return fail(res, 'Could not store final contract', 500);

  const contract = property.contract;
  contract.finalPdfUrl = url;
  contract.finalOriginalName = req.file.originalname || null;
  contract.finalMimeType = req.file.mimetype || null;
  contract.finalSignedAt = new Date();
  contract.finalSignedByOfficerId = req.pwaUser.id;

  if (property.source === 'self') {
    let emailDelivered = false;
    let emailError = null;
    try {
      await sendContract({
        to: property.ownerEmail,
        ownerName: property.ownerName,
        propertyName: property.name,
        propertyCode: property.propertyCode,
        pdfBuffer: req.file.emailAttachmentBuffer,
        pdfUrl: url,
        pdfFilename: contractFilename(property, 'final-contract'),
        subject: `Final signed contract for ${property.name} (${property.propertyCode})`,
        heading: 'Final signed contract',
        instructions: 'The fully signed contract is attached for your records. Onboarding is complete.',
      });
      emailDelivered = true;
    } catch (err) {
      emailError = err.message;
      return fail(res, `Email send failed - ${err.message}`, 500);
    }
    contract.sentAt = contract.sentAt || new Date();
    await contract.save();
    property.status = PROPERTY_STATUS.COMPLETED;
    await property.save();
    if (property.ownerId) {
      notifyUser({
        role: 'owner',
        userId: property.ownerId,
        type: 'contract_signed',
        title: `Final contract ready: ${property.propertyCode || property.name}`,
        body: 'The officer-signed final contract has been emailed and is available in your portal.',
        propertyId: property.id,
        data: { propertyCode: property.propertyCode, source: property.source },
      });
    }
    emitToProperty(property.id, 'property:status', { propertyId: property.id, status: property.status });
    return ok(res, { property, contract, emailDelivered, emailError }, 'Final contract sent to owner');
  }

  let emailDelivered = false;
  let emailError = null;
  if (property.auditor?.email) {
    try {
      await sendContract({
        to: property.auditor.email,
        ownerName: property.auditor.name,
        propertyName: property.name,
        propertyCode: property.propertyCode,
        pdfBuffer: req.file.emailAttachmentBuffer,
        pdfUrl: url,
        pdfFilename: contractFilename(property, 'final-contract'),
        subject: `Final signed contract ready for ${property.name} (${property.propertyCode})`,
        heading: 'Final signed contract ready',
        intro: `the officer has uploaded the final signed contract for <strong>${property.name}</strong>.`,
        instructions: 'The fully signed contract is attached. Please send it to the property owner from your auditor portal.',
      });
      emailDelivered = true;
    } catch (err) {
      emailError = err.message;
      if (process.env.NODE_ENV === 'production') {
        return fail(res, `Email send failed - ${err.message}`, 500);
      }
    }
  }
  contract.finalSentToAuditorAt = new Date();
  await contract.save();
  property.status = PROPERTY_STATUS.CONTRACT_SIGNED;
  await property.save();
  if (property.auditorId) {
    notifyUser({
      role: 'auditor',
      userId: property.auditorId,
      type: 'contract_signed',
      title: `Final contract ready: ${property.propertyCode || property.name}`,
      body: 'Send the officer-signed final contract to the owner.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }
  emitToProperty(property.id, 'property:status', { propertyId: property.id, status: property.status });
  return ok(res, { property, contract, emailDelivered, emailError }, 'Final contract sent to auditor');
});

const completeSelfContract = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
    include: [
      { model: Contract, as: 'contract' },
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);
  if (property.source !== 'self') {
    return fail(res, 'Auditor-onboarded contracts are completed by the auditor', 400);
  }
  if (!property.contract?.signedPdfUrl) {
    return fail(res, 'Owner signed contract is required first', 400);
  }

  const contract = property.contract;
  let emailDelivered = false;
  let emailError = null;
  try {
    await sendContract({
      to: property.ownerEmail,
      ownerName: property.ownerName,
      propertyName: property.name,
      propertyCode: property.propertyCode,
      pdfUrl: contract.signedPdfUrl,
      pdfFilename: contractFilename(property, 'final-contract'),
      subject: `Final signed contract for ${property.name} (${property.propertyCode})`,
      heading: 'Final signed contract',
      instructions: 'The fully signed contract is attached for your records. Onboarding is complete.',
    });
    emailDelivered = true;
  } catch (err) {
    emailError = err.message;
    console.warn('[PWA] final self contract email failed:', err.message);
  }

  contract.finalPdfUrl = contract.signedPdfUrl;
  contract.finalOriginalName = contract.signedOriginalName;
  contract.finalMimeType = contract.signedMimeType;
  contract.finalSignedAt = contract.signedAt || new Date();
  contract.finalSignedByOfficerId = req.pwaUser.id;
  await contract.save();

  property.status = PROPERTY_STATUS.COMPLETED;
  await property.save();

  if (property.ownerId) {
    notifyUser({
      role: 'owner',
      userId: property.ownerId,
      type: 'contract_signed',
      title: `Final contract ready: ${property.propertyCode || property.name}`,
      body: 'Your property onboarding is complete. The final contract is available in your portal.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }
  notifyUser({
    role: 'officer',
    userId: req.pwaUser.id,
    type: 'contract_signed',
    title: `Onboarding completed: ${property.propertyCode || property.name}`,
    body: 'Self-onboarded property is now final with contract.',
    propertyId: property.id,
    data: { propertyCode: property.propertyCode, source: property.source },
  });
  emitToProperty(property.id, 'property:status', { propertyId: property.id, status: property.status });

  return ok(
    res,
    { property, contract, emailDelivered, emailError },
    emailDelivered
      ? 'Onboarding completed and final contract emailed'
      : 'Onboarding completed. Email delivery failed.',
  );
});

// --- Contracts dashboard (officer side) --------------------------------
//
// Reads every contract this officer has touched, split into three buckets:
//   - sent     : contract delivered to owner, awaiting their signed copy
//   - received : owner uploaded a signed copy, awaiting listing finalization
//   - listed   : property fully completed and live
//
// Each row carries property + contract data so the UI can show the PDF
// preview link, send dates, and the owner-side signed copy.
const listContracts = asyncHandler(async (req, res) => {
  const officerId = req.pwaUser.id;
  const items = await Property.findAll({
    where: {
      assignedOfficerId: officerId,
      status: [
        PROPERTY_STATUS.FINAL_APPROVED,
        PROPERTY_STATUS.CONTRACT_SENT,
        PROPERTY_STATUS.CONTRACT_SIGNED,
        PROPERTY_STATUS.COMPLETED,
      ],
    },
    include: [
      { model: Contract, as: 'contract', required: false },
      { model: Auditor, as: 'auditor', attributes: ['id', 'name', 'email'] },
    ],
    attributes: [
      'id', 'name', 'propertyCode', 'status', 'address', 'source',
      'ownerName', 'ownerEmail', 'ownerPhone', 'approvedAt', 'finalApprovedAt',
    ],
    order: [
      ['finalApprovedAt', 'DESC'],
      [{ model: Contract, as: 'contract' }, 'generatedAt', 'DESC'],
    ],
  });
  const buckets = { upload: [], sent: [], received: [], final: [], listed: [] };
  for (const p of items) {
    if (p.status === PROPERTY_STATUS.COMPLETED) buckets.listed.push(p);
    else if (p.source !== 'self') continue;
    else if (p.contract?.signedPdfUrl && !p.contract?.finalPdfUrl) buckets.received.push(p);
    else if (p.contract?.finalPdfUrl) buckets.final.push(p);
    else if (p.contract?.generatedPdfUrl) buckets.sent.push(p);
    else buckets.upload.push(p);
  }
  return ok(res, { ...buckets, total: items.length });
});

// Proxy the generated contract PDF (officer's own copy) so they can preview
// from inside the dashboard without leaving the app.
const downloadContractPdf = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
    include: [{ model: Contract, as: 'contract' }],
  });
  if (!property?.contract?.generatedPdfUrl) {
    return fail(res, 'Contract PDF not ready', 404);
  }
  const http = require('http');
  const https = require('https');
  const fetchRemote = (url) =>
    new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      client.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          fetchRemote(r.headers.location).then(resolve).catch(reject);
          return;
        }
        if (r.statusCode !== 200) { r.resume(); return reject(new Error(`status ${r.statusCode}`)); }
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: r.headers['content-type'] }));
      }).on('error', reject);
    });
  try {
    const { buffer, contentType } = await fetchRemote(property.contract.generatedPdfUrl);
    res.setHeader('Content-Type', contentType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="contract-${property.propertyCode || property.id}.pdf"`,
    );
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    return fail(res, `Could not stream PDF — ${err.message}`, 500);
  }
});

// --- List on website -----------------------------------------------------
// The central officer pushes an approved property to the admin's listing
// queue. Eligible once the property is final-approved (and through the
// contract stages). Idempotent: re-pressing just refreshes the timestamp and
// keeps the existing draft config.
const LISTING_ELIGIBLE = [
  PROPERTY_STATUS.FINAL_APPROVED,
  PROPERTY_STATUS.CONTRACT_SENT,
  PROPERTY_STATUS.CONTRACT_SIGNED,
  PROPERTY_STATUS.COMPLETED,
];

const listOnWebsite = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.id, ...visibilityFilter(req.pwaUser.id) },
  });
  if (!property) return fail(res, 'Property not found', 404);

  if (!LISTING_ELIGIBLE.includes(property.status)) {
    return fail(res, 'Property must be final-approved before it can be listed on the website', 400);
  }

  property.listingSubmittedAt = new Date();
  await property.save();

  // Create the admin's draft listing config if it doesn't exist yet.
  let config = await PwaListingConfig.findOne({ where: { propertyId: property.id } });
  if (!config) {
    config = await PwaListingConfig.create({ propertyId: property.id, listingStatus: 'draft' });
  }

  return ok(
    res,
    { propertyId: property.id, listingSubmittedAt: property.listingSubmittedAt, listingStatus: config.listingStatus },
    'Sent to the website team — configure & publish from the admin panel',
  );
});

module.exports = {
  listProperties,
  getProperty,
  claim,
  decideField,
  updateSuggestion,
  followUpProperty,
  approveProperty,
  rejectProperty,
  listOnWebsite,
  uploadInitialContract,
  uploadFinalContract,
  completeSelfContract,
  listContracts,
  downloadContractPdf,
};

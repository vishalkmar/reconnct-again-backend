const asyncHandler = require('express-async-handler');
const http = require('http');
const https = require('https');
const { Op } = require('sequelize');
const { Property, Contract, Auditor, Officer } = require('../models');
const { ok, fail } = require('../../utils/response');
const { getUploadedUrl } = require('../../utils/uploads');
const { sendContract } = require('../services/mailer');
const { emitToProperty } = require('../services/socket');
const { notifyUser } = require('../services/notifications');
const { PROPERTY_STATUS } = require('../constants');

/*
  After the officer approves a property the contract PDF is stored but NOT
  emailed to the owner. The auditor sees the property in their "Incoming
  contracts" tab and presses "Send to owner" — only then does the owner
  receive the contract and become eligible to log in.

  Endpoints:
    GET    /api/pwa/auditor/contracts              list pending + sent contracts
    GET    /api/pwa/auditor/contracts/:propertyId  fetch one
    POST   /api/pwa/auditor/contracts/:propertyId/send-to-owner   release it
*/

const contractInclude = () => [
  { model: Contract, as: 'contract' },
];

// "Incoming" = contract PDF generated but not yet released to the owner.
const listForAuditor = asyncHandler(async (req, res) => {
  const where = {
    auditorId: req.pwaUser.id,
    status: {
      [Op.in]: [
        // Only properties whose Phase 4 has also been accepted — contract
        // is only generated after FINAL_APPROVED.
        PROPERTY_STATUS.FINAL_APPROVED,
        PROPERTY_STATUS.CONTRACT_SIGNED,
        PROPERTY_STATUS.COMPLETED,
      ],
    },
  };
  const items = await Property.findAll({
    where,
    include: [
      { model: Contract, as: 'contract', required: false },
    ],
    attributes: ['id', 'name', 'propertyCode', 'status', 'address', 'ownerName', 'ownerEmail', 'ownerPhone', 'approvedAt', 'finalApprovedAt'],
    order: [
      // Pending (no sentAt) first
      [{ model: Contract, as: 'contract' }, 'sentAt', 'ASC'],
      [{ model: Contract, as: 'contract' }, 'generatedAt', 'DESC'],
    ],
  });

  const pending = items.filter((p) => p.status === PROPERTY_STATUS.FINAL_APPROVED);
  const finalReady = items.filter((p) => p.status === PROPERTY_STATUS.CONTRACT_SIGNED && p.contract?.signedPdfUrl);
  const released = items.filter((p) => [PROPERTY_STATUS.CONTRACT_SENT, PROPERTY_STATUS.COMPLETED].includes(p.status));

  return ok(res, { pending, finalReady, released, total: items.length });
});

const getOne = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.propertyId, auditorId: req.pwaUser.id },
    include: contractInclude(),
    attributes: ['id', 'name', 'propertyCode', 'status', 'address', 'ownerName', 'ownerEmail', 'ownerPhone', 'approvedAt', 'finalApprovedAt'],
  });
  if (!property || !property.contract) return fail(res, 'Contract not found', 404);
  return ok(res, { property, contract: property.contract });
});

// Stream the stored PDF back to the auditor for inline preview. We could
// also just return the secure URL — but doing the proxy avoids exposing the
// raw Cloudinary URL to anyone who can see DOM source.
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
        reject(new Error(`Could not fetch contract PDF (${remote.statusCode})`));
        return;
      }
      const chunks = [];
      remote.on('data', (chunk) => chunks.push(chunk));
      remote.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: remote.headers['content-type'] }));
    }).on('error', reject);
  });

const downloadPdf = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.propertyId, auditorId: req.pwaUser.id },
    include: contractInclude(),
  });
  if (!property?.contract?.generatedPdfUrl) {
    return fail(res, 'Contract PDF not found', 404);
  }
  const { buffer, contentType } = await fetchRemoteBuffer(property.contract.generatedPdfUrl);
  res.setHeader('Content-Type', contentType || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="contract-${property.propertyCode || property.id}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

const uploadSignedByAuditor = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.propertyId, auditorId: req.pwaUser.id },
    include: [
      { model: Contract, as: 'contract' },
      { model: Auditor, as: 'auditor' },
      { model: Officer, as: 'officer', attributes: ['id', 'name', 'email'] },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);
  if (property.status !== PROPERTY_STATUS.FINAL_APPROVED) {
    return fail(res, 'Contract can be uploaded only after final approval', 400);
  }
  if (!req.file) return fail(res, 'Upload a contract PDF', 400);

  const url = getUploadedUrl(req.file);
  if (!url) return fail(res, 'Could not store contract', 500);

  let contract = property.contract;
  if (!contract) contract = await Contract.create({ propertyId: property.id });
  contract.generatedPdfUrl = url;
  contract.generatedAt = new Date();
  contract.sentAt = null;
  contract.releasedByAuditorId = null;
  contract.signedPdfUrl = null;
  contract.signedOriginalName = null;
  contract.signedMimeType = null;
  contract.signedAt = null;
  contract.ownerSignedByEmail = null;
  contract.finalPdfUrl = null;
  contract.finalSignedAt = null;
  contract.finalSentToAuditorAt = null;

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
      pdfFilename: `contract-${property.propertyCode || property.id}.pdf`,
      subject: `Please e-sign contract for ${property.name} (${property.propertyCode})`,
      heading: 'Please e-sign your contract',
      instructions: 'The contract is attached as a PDF. Please digitally sign it, then upload the signed copy in your owner portal.',
    });
    emailDelivered = true;
  } catch (err) {
    emailError = err.message;
    console.warn('[PWA] contract email send failed:', err.message);
    return fail(res, `Email send failed - ${err.message}`, 500);
  }
  contract.sentAt = new Date();
  contract.releasedByAuditorId = req.pwaUser.id;
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
  if (property.assignedOfficerId) {
    notifyUser({
      role: 'officer',
      userId: property.assignedOfficerId,
      type: 'contract_sent_to_owner',
      title: `Contract sent by auditor: ${property.propertyCode || property.name}`,
      body: `Emailed to ${property.ownerEmail}.`,
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }
  emitToProperty(property.id, 'property:status', { propertyId: property.id, status: property.status });
  return ok(res, { property, contract, emailDelivered, emailError }, 'Contract sent to owner for e-sign');
});

const sendToOwner = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    where: { id: req.params.propertyId, auditorId: req.pwaUser.id },
    include: [
      { model: Contract, as: 'contract' },
      { model: Auditor, as: 'auditor' },
    ],
  });
  if (!property) return fail(res, 'Property not found', 404);

  if (property.contract?.sentAt) {
    // Initial contract sentAt is already set in this flow; final completion is
    // allowed after the owner uploads their signed copy.
  }
  if (!property.contract?.signedPdfUrl) {
    return fail(res, 'Owner e-signed contract is not uploaded yet', 400);
  }

  let emailDelivered = false;
  let emailError = null;
  try {
    await sendContract({
      to: property.ownerEmail,
      ownerName: property.ownerName,
      propertyName: property.name,
      propertyCode: property.propertyCode,
      pdfUrl: property.contract.signedPdfUrl,
      pdfFilename: `final-contract-${property.propertyCode || property.id}.pdf`,
      subject: `Final signed contract for ${property.name} (${property.propertyCode})`,
      heading: 'Final signed contract',
      instructions: 'The fully signed contract is attached for your records. Onboarding is complete.',
    });
    emailDelivered = true;
  } catch (err) {
    emailError = err.message;
    console.warn('[PWA] contract email send failed:', err.message);
    return fail(res, `Email send failed - ${err.message}`, 500);
  }

  let contract = property.contract;
  if (!contract) {
    contract = await Contract.create({ propertyId: property.id });
    property.contract = contract;
  }
  contract.sentAt = new Date();
  contract.releasedByAuditorId = req.pwaUser.id;
  contract.finalPdfUrl = contract.signedPdfUrl;
  contract.finalOriginalName = contract.signedOriginalName;
  contract.finalMimeType = contract.signedMimeType;
  contract.finalSignedAt = contract.signedAt || new Date();
  await contract.save();

  property.status = PROPERTY_STATUS.COMPLETED;
  await property.save();

  emitToProperty(property.id, 'property:status', {
    propertyId: property.id,
    status: property.status,
  });

  // Ping the assigned officer so they see the loop closed; the auditor
  // doesn't need a self-notification (their UI already updates).
  if (property.assignedOfficerId) {
    notifyUser({
      role: 'officer',
      userId: property.assignedOfficerId,
      type: 'contract_sent_to_owner',
      title: `Final contract sent to owner: ${property.propertyCode || property.name}`,
      body: `Emailed to ${property.ownerEmail}.`,
      propertyId: property.id,
    });
  }
  if (property.ownerId) {
    notifyUser({
      role: 'owner',
      userId: property.ownerId,
      type: 'contract_signed',
      title: `Final contract ready: ${property.propertyCode || property.name}`,
      body: 'The final e-signed contract has been emailed and is available in your portal.',
      propertyId: property.id,
      data: { propertyCode: property.propertyCode, source: property.source },
    });
  }

  return ok(
    res,
    { property, contract: property.contract, emailDelivered, emailError },
    emailDelivered
      ? 'Final contract sent to owner'
      : 'Final contract marked sent - email service was unreachable',
  );
});

module.exports = {
  listForAuditor,
  getOne,
  downloadPdf,
  uploadSignedByAuditor,
  sendToOwner,
};

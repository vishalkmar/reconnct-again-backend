const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  AvailabilityLead,
  Salesperson,
  PropertyOwner,
  VoiceCallLog,
} = require('../models');
const { Package } = require('../../models');
const { ok, fail } = require('../../utils/response');
const { placeCall } = require('../services/voiceCall');

const leadInclude = () => [
  {
    model: Package, as: 'package',
    attributes: ['id', 'name', 'slug', 'primaryImage', 'priceFrom', 'currency', 'durationDays', 'durationNights', 'ownerContactName', 'ownerContactPhone'],
  },
  { model: PropertyOwner, as: 'owner', attributes: ['id', 'name', 'email', 'phone'] },
  { model: AvailabilityLead, as: 'parent' },
  { model: AvailabilityLead, as: 'followUps' },
  { model: VoiceCallLog, as: 'voiceCalls' },
];

// GET /api/pwa/salesperson/leads?status=pending|owner_yes|owner_no|not_converted
const listMyLeads = asyncHandler(async (req, res) => {
  const where = { salespersonId: req.pwaUser.id };
  const { status, q } = req.query;
  if (status) where.status = status;
  if (q) {
    where[Op.or] = [
      { customerName:  { [Op.like]: `%${q}%` } },
      { customerPhone: { [Op.like]: `%${q}%` } },
      { customerEmail: { [Op.like]: `%${q}%` } },
    ];
  }

  const items = await AvailabilityLead.findAll({
    where,
    include: leadInclude(),
    order: [['createdAt', 'DESC']],
  });

  // Buckets for the dashboard tabs
  const all = await AvailabilityLead.findAll({
    where: { salespersonId: req.pwaUser.id },
    attributes: ['status'],
  });
  const buckets = {
    pending:        all.filter((l) => l.status === 'pending').length,
    owner_yes:      all.filter((l) => l.status === 'owner_yes').length,
    owner_no:       all.filter((l) => l.status === 'owner_no').length,
    not_converted:  all.filter((l) => l.status === 'not_converted').length,
    converted:      all.filter((l) => l.status === 'converted').length,
    total:          all.length,
  };

  return ok(res, { items, buckets });
});

// GET /api/pwa/salesperson/leads/:leadId
const getLead = asyncHandler(async (req, res) => {
  const lead = await AvailabilityLead.findOne({
    where: { id: req.params.leadId, salespersonId: req.pwaUser.id },
    include: leadInclude(),
  });
  if (!lead) return fail(res, 'Lead not found', 404);
  return ok(res, { lead });
});

// POST /api/pwa/salesperson/leads/:leadId/not-converted
const markNotConverted = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return fail(res, 'Reason is required', 400);

  const lead = await AvailabilityLead.findOne({
    where: { id: req.params.leadId, salespersonId: req.pwaUser.id },
  });
  if (!lead) return fail(res, 'Lead not found', 404);

  lead.status = 'not_converted';
  lead.lostReason = reason.trim();
  lead.closedBySalespersonAt = new Date();
  await lead.save();

  const fresh = await AvailabilityLead.findByPk(lead.id, { include: leadInclude() });
  return ok(res, { lead: fresh }, 'Lead marked as not converted');
});

// POST /api/pwa/salesperson/leads/:leadId/converted
const markConverted = asyncHandler(async (req, res) => {
  const lead = await AvailabilityLead.findOne({
    where: { id: req.params.leadId, salespersonId: req.pwaUser.id },
  });
  if (!lead) return fail(res, 'Lead not found', 404);
  lead.status = 'converted';
  lead.closedBySalespersonAt = new Date();
  await lead.save();
  const fresh = await AvailabilityLead.findByPk(lead.id, { include: leadInclude() });
  return ok(res, { lead: fresh }, 'Lead marked as converted');
});

// POST /api/pwa/salesperson/leads/:leadId/request-another-date
//   Spawns a NEW lead with the same customer details + a new requestedDate.
//   The new row's parentLeadId points back to this one so the salesperson
//   can see the chain. The original lead remains in its `owner_no` state.
const requestAnotherDate = asyncHandler(async (req, res) => {
  const { requestedDate, notes } = req.body;
  if (!requestedDate) return fail(res, 'New requested date is required', 400);

  const original = await AvailabilityLead.findOne({
    where: { id: req.params.leadId, salespersonId: req.pwaUser.id },
  });
  if (!original) return fail(res, 'Lead not found', 404);
  if (original.status !== 'owner_no') {
    return fail(res, 'Re-requests are only allowed after the owner has declined', 400);
  }

  const followUp = await AvailabilityLead.create({
    packageId:     original.packageId,
    ownerId:       original.ownerId,
    salespersonId: original.salespersonId,
    customerName:  original.customerName,
    customerPhone: original.customerPhone,
    customerEmail: original.customerEmail,
    requestedDate,
    notes: notes?.trim() || `Re-request after ${original.requestedDate} declined`,
    status: 'pending',
    parentLeadId: original.id,
    iteration: (original.iteration || 1) + 1,
  });

  // Fire voice calls again for the new lead
  const pkg = await Package.findByPk(original.packageId, {
    attributes: ['id', 'name', 'ownerContactPhone', 'ownerContactName'],
  });
  let ownerPhone = pkg?.ownerContactPhone;
  let ownerName  = pkg?.ownerContactName;
  if (original.ownerId) {
    const owner = await PropertyOwner.findByPk(original.ownerId);
    if (owner) { ownerPhone = owner.phone || ownerPhone; ownerName = owner.name || ownerName; }
  }
  if (ownerPhone) {
    placeCall({
      leadId: followUp.id,
      recipientRole: 'owner',
      recipientPhone: ownerPhone,
      recipientName: ownerName,
      packageName: pkg?.name,
      leadCustomerName: followUp.customerName,
      leadDate: followUp.requestedDate,
    }).then(() => AvailabilityLead.update({ ownerCallQueuedAt: new Date() }, { where: { id: followUp.id } })).catch(() => {});
  }

  const fresh = await AvailabilityLead.findByPk(followUp.id, { include: leadInclude() });
  return ok(res, { lead: fresh }, 'New date requested');
});

module.exports = {
  listMyLeads,
  getLead,
  markNotConverted,
  markConverted,
  requestAnotherDate,
};

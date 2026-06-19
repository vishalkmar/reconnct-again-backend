const asyncHandler = require('express-async-handler');
const { Contract, Supplier, Experience, SiteSetting } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { generateContractPdf, generateContractDoc } = require('../services/supplierContract');
const { KEY: PROFILE_KEY, DEFAULTS: PROFILE_DEFAULTS } = require('./companyProfile.controller');

const SUPPLIER_ATTRS = ['id', 'companyName', 'supplierName', 'phone', 'email', 'image'];

const loadOperator = async () => {
  const row = await SiteSetting.findOne({ where: { key: PROFILE_KEY } });
  return { ...PROFILE_DEFAULTS, ...(row?.value || {}) };
};

const snapshotSupplier = (s) => (s ? {
  id: s.id, companyName: s.companyName, supplierName: s.supplierName, phone: s.phone, email: s.email, image: s.image,
} : {});

// Build the generator payload from a stored contract row (filtered items).
const buildDocData = (contract) => {
  const items = (Array.isArray(contract.items) ? contract.items : [])
    .filter((it) => it.include !== false && Number(it.b2bPrice) > 0)
    .map((it) => ({ name: it.name, b2bPrice: Number(it.b2bPrice) || 0, dates: Array.isArray(it.dates) ? it.dates : [] }));
  return {
    title: contract.title,
    operator: contract.operatorSnapshot || {},
    supplier: contract.supplierSnapshot || {},
    intro: contract.intro || '',
    formalities: contract.formalities || '',
    items,
  };
};

const WRITABLE = ['supplierId', 'title', 'intro', 'formalities', 'items', 'status'];
const pickWritable = (body) => {
  const out = {};
  for (const k of WRITABLE) if (k in body) out[k] = body[k];
  if (out.items && !Array.isArray(out.items)) out.items = [];
  return out;
};

const INCLUDE = [{ model: Supplier, as: 'supplier', attributes: SUPPLIER_ATTRS }];

// GET /api/contracts
const list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.supplierId) where.supplierId = parseInt(req.query.supplierId, 10);
  const items = await Contract.findAll({ where, include: INCLUDE, order: [['createdAt', 'DESC']] });
  return ok(res, { items });
});

// GET /api/contracts/:id
const getOne = asyncHandler(async (req, res) => {
  const item = await Contract.findByPk(req.params.id, { include: INCLUDE });
  if (!item) return fail(res, 'Contract not found', 404);
  return ok(res, { item });
});

// Refresh snapshots from the live supplier + company profile.
const withSnapshots = async (data) => {
  const out = { ...data };
  out.operatorSnapshot = await loadOperator();
  if (data.supplierId) {
    const s = await Supplier.findByPk(data.supplierId);
    out.supplierSnapshot = snapshotSupplier(s);
  }
  return out;
};

// POST /api/contracts
const create = asyncHandler(async (req, res) => {
  const data = pickWritable(req.body);
  if (!data.supplierId) return fail(res, 'Pick a supplier', 400);
  // One contract per supplier — enforce the one-time rule.
  const existing = await Contract.findOne({ where: { supplierId: data.supplierId } });
  if (existing) return fail(res, 'This supplier already has a contract. Edit or delete the existing one.', 409);
  const full = await withSnapshots(data);
  const item = await Contract.create(full);
  const withInc = await Contract.findByPk(item.id, { include: INCLUDE });
  return created(res, { item: withInc }, 'Contract saved');
});

// PUT /api/contracts/:id
const update = asyncHandler(async (req, res) => {
  const item = await Contract.findByPk(req.params.id);
  if (!item) return fail(res, 'Contract not found', 404);
  const data = pickWritable(req.body);
  const full = await withSnapshots({ supplierId: data.supplierId ?? item.supplierId, ...data });
  await item.update(full);
  const withInc = await Contract.findByPk(item.id, { include: INCLUDE });
  return ok(res, { item: withInc }, 'Contract updated');
});

// DELETE /api/contracts/:id
const remove = asyncHandler(async (req, res) => {
  const item = await Contract.findByPk(req.params.id);
  if (!item) return fail(res, 'Contract not found', 404);
  await item.destroy();
  return ok(res, {}, 'Contract deleted');
});

const safeName = (contract, ext) => {
  const base = `contract-${(contract.supplierSnapshot?.companyName || 'supplier')}-${contract.id}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base}.${ext}`;
};

// GET /api/contracts/:id/pdf
const downloadPdf = asyncHandler(async (req, res) => {
  const item = await Contract.findByPk(req.params.id);
  if (!item) return fail(res, 'Contract not found', 404);
  const buf = await generateContractPdf(buildDocData(item));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(item, 'pdf')}"`);
  return res.send(buf);
});

// GET /api/contracts/:id/word
const downloadWord = asyncHandler(async (req, res) => {
  const item = await Contract.findByPk(req.params.id);
  if (!item) return fail(res, 'Contract not found', 404);
  const buf = generateContractDoc(buildDocData(item));
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(item, 'doc')}"`);
  return res.send(buf);
});

module.exports = { list, getOne, create, update, remove, downloadPdf, downloadWord };

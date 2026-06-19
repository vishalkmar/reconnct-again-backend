const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok } = require('../utils/response');

// Our (portal owner) profile — the "Operator" / "between" party printed on every
// contract. Stored as a single SiteSetting row so it doesn't need its own table.
const KEY = 'company_profile';

const DEFAULTS = {
  companyName: '',
  name: '',          // signatory / contact person
  email: '',
  phone: '',
  address: '',
  logo: '',
  image: '',
};

// GET /api/admin/company-profile
const get = asyncHandler(async (req, res) => {
  const row = await SiteSetting.findOne({ where: { key: KEY } });
  return ok(res, { profile: { ...DEFAULTS, ...(row?.value || {}) } });
});

// PUT /api/admin/company-profile
const update = asyncHandler(async (req, res) => {
  const next = {};
  for (const k of Object.keys(DEFAULTS)) if (k in req.body) next[k] = req.body[k] ?? '';
  const [row] = await SiteSetting.findOrCreate({ where: { key: KEY }, defaults: { key: KEY, value: {} } });
  row.value = { ...DEFAULTS, ...(row.value || {}), ...next };
  row.changed('value', true);
  await row.save();
  return ok(res, { profile: row.value }, 'Company profile saved');
});

module.exports = { get, update, KEY, DEFAULTS };

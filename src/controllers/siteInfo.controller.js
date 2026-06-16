const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const SETTING_KEY = 'site_info';

const DEFAULTS = {
  companyName: '',
  tagline: '',
  description: '',
  logoUrl: null,
  emails: [],
  phones: [],
  addresses: [],
  socials: [], // { platform, url }
  // Admin-editable legal pages (rich-text HTML), shown on /privacy and /terms.
  privacyPolicy: '',
  termsConditions: '',
};

const readInfo = async () => {
  const row = await SiteSetting.findOne({ where: { key: SETTING_KEY } });
  return { ...DEFAULTS, ...(row?.value || {}) };
};

const writeInfo = async (next) => {
  const merged = { ...DEFAULTS, ...next };
  const [row] = await SiteSetting.findOrCreate({
    where: { key: SETTING_KEY },
    defaults: { key: SETTING_KEY, value: merged },
  });
  row.value = merged;
  await row.save();
  return merged;
};

// Coerce a value coming from FormData (which serialises everything to string)
// back to its expected JSON shape.
const parseList = (raw) => {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// GET /api/site-info  (public)
const get = asyncHandler(async (_req, res) => {
  const info = await readInfo();
  return ok(res, { siteInfo: info });
});

// PUT /api/site-info  (admin, multipart for logo)
const update = asyncHandler(async (req, res) => {
  const current = await readInfo();
  const body = req.body || {};
  const logoFile = req.files?.logo?.[0];

  const next = { ...current };

  if (body.companyName !== undefined) next.companyName = body.companyName || '';
  if (body.tagline !== undefined) next.tagline = body.tagline || '';
  if (body.description !== undefined) next.description = body.description || '';
  if (body.privacyPolicy !== undefined) next.privacyPolicy = body.privacyPolicy || '';
  if (body.termsConditions !== undefined) next.termsConditions = body.termsConditions || '';

  if (body.emails !== undefined) {
    next.emails = parseList(body.emails)
      .map((s) => String(s).trim())
      .filter(Boolean);
  }
  if (body.phones !== undefined) {
    next.phones = parseList(body.phones)
      .map((s) => String(s).trim())
      .filter(Boolean);
  }
  if (body.addresses !== undefined) {
    next.addresses = parseList(body.addresses)
      .map((s) => String(s).trim())
      .filter(Boolean);
  }
  if (body.socials !== undefined) {
    next.socials = parseList(body.socials)
      .map((s) => ({
        platform: String(s.platform || '').trim().toLowerCase(),
        url: String(s.url || '').trim(),
      }))
      .filter((s) => s.platform && s.url);
  }

  if (logoFile) {
    if (current.logoUrl) await removeUploadedFile(current.logoUrl);
    next.logoUrl = getUploadedUrl(logoFile);
  } else if (body.removeLogo === 'true' && current.logoUrl) {
    await removeUploadedFile(current.logoUrl);
    next.logoUrl = null;
  }

  const saved = await writeInfo(next);
  return ok(res, { siteInfo: saved }, 'Site info saved');
});

module.exports = { get, update };

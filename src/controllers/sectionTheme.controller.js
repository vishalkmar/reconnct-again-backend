const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok } = require('../utils/response');

const SETTING_KEY = 'section_themes';

// Default colors per section. Frontend falls back to these when admin hasn't
// customised them yet. Stored as hex strings so they can be fed straight
// into inline `style={{ background: ... }}`.
const DEFAULTS = {
  clientReviews: {
    bg: '#ffffff',
    card: '#ffffff',
    text: '#0f172a',
    accent: '#0d9488',
  },
  videoBand: {
    bg: '#0f172a',
    card: '#1e293b',
    text: '#ffffff',
    accent: '#0d9488',
  },
  testimonialsCarousel: {
    bg: '#f8fafc',
    card: '#ffffff',
    text: '#0f172a',
    accent: '#0d9488',
  },
  testimonialsGrid: {
    bg: '#f8fafc',
    card: '#ffffff',
    text: '#0f172a',
    accent: '#0d9488',
  },
};

const readThemes = async () => {
  const row = await SiteSetting.findOne({ where: { key: SETTING_KEY } });
  const saved = row?.value || {};
  // Deep-merge each section with its defaults so partial saves still work.
  const out = {};
  Object.keys(DEFAULTS).forEach((k) => {
    out[k] = { ...DEFAULTS[k], ...(saved[k] || {}) };
  });
  return out;
};

// GET /api/section-themes  (public)
const get = asyncHandler(async (_req, res) => {
  const themes = await readThemes();
  return ok(res, { themes });
});

// PUT /api/section-themes  (admin, JSON body)
const update = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const next = { ...(await readThemes()) };
  Object.keys(DEFAULTS).forEach((sec) => {
    if (body[sec] && typeof body[sec] === 'object') {
      next[sec] = { ...next[sec], ...body[sec] };
    }
  });
  const [row] = await SiteSetting.findOrCreate({
    where: { key: SETTING_KEY },
    defaults: { key: SETTING_KEY, value: next },
  });
  row.value = next;
  await row.save();
  return ok(res, { themes: next }, 'Section themes saved');
});

module.exports = { get, update, DEFAULTS };

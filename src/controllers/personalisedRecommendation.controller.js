const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

// One settings row controls the "Not sure which retreat is perfect for you?"
// section on the home page. JSON-blob via the generic SiteSetting key/value
// store so no separate schema is needed.
const SETTING_KEY = 'personalised_recommendation';

const DEFAULTS = {
  heading: 'Not sure which retreat is perfect for you?',
  subheading:
    'Tell us your mood, destination preference and budget. Our wellness team will shortlist stays, packages and healing experiences that actually fit your plan.',

  // Top-row CTAs
  primaryCtaLabel: 'Get personalised recommendations',
  primaryCtaUrl: '/retreats',
  whatsappCtaLabel: 'WhatsApp expert',
  whatsappUrl:
    'https://wa.me/?text=Hi%2C%20I%20need%20help%20choosing%20a%20wellness%20retreat.',

  // Three quick-link cards under the CTAs (label / tooltip / url / icon name).
  quickLinks: [
    {
      label: 'Top packages',
      tooltip: 'Curated wellness packages with stay, meals and healing activities.',
      url: '/retreats',
      icon: 'PackageOpen',
    },
    {
      label: 'Hotels',
      tooltip: 'Hand-picked wellness hotels and retreat stays.',
      url: '/hotels',
      icon: 'BedDouble',
    },
    {
      label: 'All in one place',
      tooltip: 'Compare hotels, packages and events together.',
      url: '/retreats',
      icon: 'CalendarDays',
    },
  ],

  // The center image (over the spinning rings). Admin can replace at will.
  centerImageUrl: null,

  // Floating-card overlays on the right column
  liveMatchTitle: 'Live match',
  liveMatchSubtitle: 'Hotels + packages + events',
  topRatedTitle: 'Top rated',
  topRatedSubtitle: '4.9 wellness score',
  bottomBadgeTitle: '48 hr plan',
  bottomBadgeSubtitle: 'Custom shortlist',
  ringBadgeText: '10+',
  ringBadgeLabel: 'wellness filters',
};

const read = async () => {
  const row = await SiteSetting.findOne({ where: { key: SETTING_KEY } });
  return { ...DEFAULTS, ...(row?.value || {}) };
};

const write = async (next) => {
  const merged = { ...DEFAULTS, ...next };
  const [row] = await SiteSetting.findOrCreate({
    where: { key: SETTING_KEY },
    defaults: { key: SETTING_KEY, value: merged },
  });
  row.value = merged;
  await row.save();
  return merged;
};

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

// GET /api/personalised-recommendation  (public)
const get = asyncHandler(async (_req, res) => {
  const config = await read();
  return ok(res, { personalisedRecommendation: config });
});

// PUT /api/personalised-recommendation  (admin, multipart for centerImage)
const update = asyncHandler(async (req, res) => {
  const current = await read();
  const body = req.body || {};
  const imageFile = req.files?.centerImage?.[0];

  const next = { ...current };

  const stringFields = [
    'heading', 'subheading',
    'primaryCtaLabel', 'primaryCtaUrl',
    'whatsappCtaLabel', 'whatsappUrl',
    'liveMatchTitle', 'liveMatchSubtitle',
    'topRatedTitle', 'topRatedSubtitle',
    'bottomBadgeTitle', 'bottomBadgeSubtitle',
    'ringBadgeText', 'ringBadgeLabel',
  ];
  for (const field of stringFields) {
    if (body[field] !== undefined) next[field] = body[field] ?? '';
  }

  if (body.quickLinks !== undefined) {
    next.quickLinks = parseList(body.quickLinks)
      .map((q) => ({
        label: String(q.label || '').trim(),
        tooltip: String(q.tooltip || '').trim(),
        url: String(q.url || '').trim(),
        icon: String(q.icon || '').trim() || 'PackageOpen',
      }))
      .filter((q) => q.label && q.url)
      .slice(0, 6);
  }

  if (imageFile) {
    if (current.centerImageUrl) await removeUploadedFile(current.centerImageUrl);
    next.centerImageUrl = getUploadedUrl(imageFile);
  } else if (body.removeCenterImage === 'true' && current.centerImageUrl) {
    await removeUploadedFile(current.centerImageUrl);
    next.centerImageUrl = null;
  }

  const saved = await write(next);
  return ok(res, { personalisedRecommendation: saved }, 'Section saved');
});

module.exports = { get, update };

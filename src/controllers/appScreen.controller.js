const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok, fail } = require('../utils/response');

/*
  "App Screens Control" — admin-editable content for the mobile app's screens
  (currently the Login/OTP screen). Stored in the generic SiteSetting key/value
  table under `app_screen_<key>` so no migration is needed.

  media shape: { type: 'image' | 'gif' | 'video', url }
*/

const DEFAULTS = {
  login: {
    brandTitle: 'reconnct',
    tagline: 'Experiences that connect',
    heroMedia: { type: 'image', url: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=900&q=80' },
    headline: 'Let’s get you started',
    subtitle: 'Enter your email to discover amazing experiences around you.',
    buttonText: 'Send OTP',
    emailPlaceholder: 'Enter your email',
    legal: 'By continuing, you agree to our Terms of Use & Privacy Policy',
    // OTP step
    otpHeadline: 'Almost there!',
    otpSubtitle: 'We’ve sent a 6-digit code to',
    otpMedia: { type: 'image', url: 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=900&q=80' },
    secureText: 'Secure & encrypted',
  },
};

const settingKey = (key) => `app_screen_${key}`;

const read = async (key) => {
  const row = await SiteSetting.findOne({ where: { key: settingKey(key) } });
  return { ...(DEFAULTS[key] || {}), ...(row && row.value ? row.value : {}) };
};

// GET /api/public/app-screen/:key
const getScreen = asyncHandler(async (req, res) => {
  const key = req.params.key;
  if (!DEFAULTS[key]) return fail(res, 'Unknown screen', 404);
  return ok(res, { key, content: await read(key) });
});

// PUT /api/admin/app-screens/:key  (admin) — body is the full content object
const updateScreen = asyncHandler(async (req, res) => {
  const key = req.params.key;
  if (!DEFAULTS[key]) return fail(res, 'Unknown screen', 404);
  const merged = { ...DEFAULTS[key], ...(req.body || {}) };
  const [row] = await SiteSetting.findOrCreate({
    where: { key: settingKey(key) },
    defaults: { key: settingKey(key), value: merged },
  });
  row.value = merged;
  await row.save();
  return ok(res, { key, content: merged }, 'App screen updated');
});

// ── Offer banners (auto-sliding carousel on Home) ────────────────────────
// type: 'image' (plain advert) | 'image_text' (image + title/subtitle + CTA)
const BANNER_KEY = 'offer_banners';
const DEFAULT_BANNERS = [
  {
    id: 1, type: 'image_text', active: true,
    image: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=1000&q=80',
    title: 'EARLY BIRD SPECIAL', subtitle: 'Unlock exclusive adventures! Book now',
    ctaText: 'BOOK NOW', ctaLink: '',
  },
  {
    id: 2, type: 'image_text', active: true,
    image: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1000&q=80',
    title: 'WEEKEND ESCAPES', subtitle: 'Up to 20% off coastal getaways',
    ctaText: 'EXPLORE', ctaLink: '',
  },
];

// GET /api/public/offer-banners
const getBanners = asyncHandler(async (req, res) => {
  const row = await SiteSetting.findOne({ where: { key: BANNER_KEY } });
  const banners = (row && Array.isArray(row.value)) ? row.value : DEFAULT_BANNERS;
  return ok(res, { banners: banners.filter((b) => b && b.active !== false) });
});

// GET /api/admin/offer-banners (admin) — full list incl. inactive
const adminGetBanners = asyncHandler(async (req, res) => {
  const row = await SiteSetting.findOne({ where: { key: BANNER_KEY } });
  return ok(res, { banners: (row && Array.isArray(row.value)) ? row.value : DEFAULT_BANNERS });
});

// PUT /api/admin/offer-banners (admin) — body: { banners: [...] }
const updateBanners = asyncHandler(async (req, res) => {
  const banners = Array.isArray(req.body.banners) ? req.body.banners : [];
  const [row] = await SiteSetting.findOrCreate({ where: { key: BANNER_KEY }, defaults: { key: BANNER_KEY, value: banners } });
  row.value = banners;
  await row.save();
  return ok(res, { banners }, 'Offer banners saved');
});

module.exports = { getScreen, updateScreen, getBanners, adminGetBanners, updateBanners, DEFAULTS };

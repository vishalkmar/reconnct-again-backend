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

module.exports = { getScreen, updateScreen, DEFAULTS };

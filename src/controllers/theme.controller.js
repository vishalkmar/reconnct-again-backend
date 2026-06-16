const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok, fail } = require('../utils/response');

const THEME_KEY = 'theme';

const DEFAULT_THEME = {
  brand: '13 148 136',
  brandLight: '45 212 191',
  brandDark: '15 118 110',
  wellness: '16 185 129',
  wellnessLight: '52 211 153',
  wellnessDark: '5 150 105',
  accent: '250 204 21',
  ink: '17 24 39',
  inkMuted: '100 116 139',
  surface: '255 255 255',
  surfaceAlt: '248 250 252',
};

const PRESETS = [
  {
    id: 'default',
    name: 'Default — Wellness Green',
    theme: DEFAULT_THEME,
  },
  {
    id: 'ocean',
    name: 'Ocean — Deep Blue + Aqua',
    theme: {
      brand: '37 99 235',
      brandLight: '96 165 250',
      brandDark: '29 78 216',
      wellness: '6 182 212',
      wellnessLight: '34 211 238',
      wellnessDark: '14 116 144',
      accent: '250 204 21',
      ink: '15 23 42',
      inkMuted: '100 116 139',
      surface: '255 255 255',
      surfaceAlt: '241 245 249',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset — Coral + Forest',
    theme: {
      brand: '244 114 182',
      brandLight: '251 207 232',
      brandDark: '219 39 119',
      wellness: '34 197 94',
      wellnessLight: '134 239 172',
      wellnessDark: '21 128 61',
      accent: '251 191 36',
      ink: '24 24 27',
      inkMuted: '113 113 122',
      surface: '255 255 255',
      surfaceAlt: '250 250 250',
    },
  },
  {
    id: 'wellness',
    name: 'Wellness — Emerald + Lime',
    theme: {
      brand: '16 185 129',
      brandLight: '110 231 183',
      brandDark: '4 120 87',
      wellness: '101 163 13',
      wellnessLight: '163 230 53',
      wellnessDark: '63 98 18',
      accent: '253 224 71',
      ink: '20 30 27',
      inkMuted: '100 116 139',
      surface: '255 255 255',
      surfaceAlt: '240 253 244',
    },
  },
];

// GET /api/theme  (public)
const getTheme = asyncHandler(async (req, res) => {
  const setting = await SiteSetting.findOne({ where: { key: THEME_KEY } });
  const theme = { ...DEFAULT_THEME, ...(setting?.value || {}) };
  return ok(res, { theme });
});

// GET /api/theme/presets  (public)
const getPresets = asyncHandler(async (req, res) => ok(res, { presets: PRESETS }));

// PUT /api/theme  (admin)
const updateTheme = asyncHandler(async (req, res) => {
  const { theme } = req.body;
  if (!theme || typeof theme !== 'object') return fail(res, 'theme object is required', 400);

  // Whitelist + merge
  const allowed = Object.keys(DEFAULT_THEME);
  const safe = {};
  allowed.forEach((k) => {
    if (theme[k] !== undefined && typeof theme[k] === 'string') safe[k] = theme[k];
  });

  const merged = { ...DEFAULT_THEME, ...safe };

  const [setting] = await SiteSetting.findOrCreate({
    where: { key: THEME_KEY },
    defaults: { key: THEME_KEY, value: merged },
  });
  setting.value = merged;
  await setting.save();

  return ok(res, { theme: merged }, 'Theme saved');
});

// POST /api/theme/reset  (admin)
const resetTheme = asyncHandler(async (req, res) => {
  await SiteSetting.destroy({ where: { key: THEME_KEY } });
  return ok(res, { theme: DEFAULT_THEME }, 'Theme reset to default');
});

module.exports = { getTheme, getPresets, updateTheme, resetTheme, DEFAULT_THEME, PRESETS };

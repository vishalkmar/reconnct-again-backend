const asyncHandler = require('express-async-handler');
const { FeaturedTab } = require('../models');
const { ok, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

const VALID_KEYS = ['all', 'hotels', 'packages', 'events'];

// GET /api/featured-tabs  (public + admin — same data)
const list = asyncHandler(async (req, res) => {
  const items = await FeaturedTab.findAll({ order: [['id', 'ASC']] });
  return ok(res, { items });
});

// PUT /api/featured-tabs/:tabKey  (admin — update label/headline/image)
const updateTab = asyncHandler(async (req, res) => {
  const { tabKey } = req.params;
  if (!VALID_KEYS.includes(tabKey)) return fail(res, 'Invalid tabKey', 400);

  const tab = await FeaturedTab.findOne({ where: { tabKey } });
  if (!tab) return fail(res, 'Tab not found — seed may not have run', 404);

  const body = req.body;
  const imageFile = req.files?.image?.[0];

  ['label', 'sublabel', 'headline', 'subheadline'].forEach((f) => {
    if (body[f] !== undefined) tab[f] = body[f] === '' ? null : body[f];
  });
  if (body.isActive !== undefined) tab.isActive = body.isActive === 'true' || body.isActive === true;

  if (imageFile) {
    if (tab.imageUrl) removeFileIfLocal(tab.imageUrl);
    tab.imageUrl = buildUrl(imageFile);
  } else if (body.clearImage === 'true') {
    if (tab.imageUrl) removeFileIfLocal(tab.imageUrl);
    tab.imageUrl = null;
  }

  await tab.save();
  return ok(res, { tab }, 'Featured tab updated');
});

module.exports = { list, updateTab };

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { PromoBanner, PromoBannerSlide, sequelize } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

const parseJsonField = (raw, fallback = []) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (Array.isArray(raw) || typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
};

const baseInclude = () => [
  {
    model: PromoBannerSlide,
    as: 'slides',
    separate: true,
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  },
];

const detectVideoProvider = (url = '') => {
  if (!url) return null;
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/vimeo\.com/i.test(url)) return 'vimeo';
  if (/\.mp4(\?|$)/i.test(url)) return 'mp4';
  return 'other';
};

// ─── Public ───────────────────────────────────────────────────────────────

// GET /api/promo-banners?page=home&position=below-video-testimonials
const listPublic = asyncHandler(async (req, res) => {
  const { page, position } = req.query;
  const where = { isActive: true };
  if (page) where.page = { [Op.in]: [page, 'all'] };
  if (position) where.position = position;

  const items = await PromoBanner.findAll({
    where,
    include: baseInclude(),
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  // Strip empty banners (no slides)
  const filtered = items.filter((b) => (b.slides || []).length > 0);
  return ok(res, { items: filtered });
});

// ─── Admin ────────────────────────────────────────────────────────────────

const listAdmin = asyncHandler(async (req, res) => {
  const items = await PromoBanner.findAll({
    include: baseInclude(),
    order: [['sortOrder', 'ASC'], ['id', 'DESC']],
  });
  return ok(res, { items });
});

const getAdminOne = asyncHandler(async (req, res) => {
  const item = await PromoBanner.findByPk(req.params.id, { include: baseInclude() });
  if (!item) return fail(res, 'Banner not found', 404);
  return ok(res, { banner: item });
});

// Multipart payload — admin can upload many image files in field `media[]`
// AND supply slide metadata as JSON in `slides`. The two are matched by index
// when a slide.mediaUrl is the placeholder '__file:<i>__'.
const createBanner = asyncHandler(async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const body = req.body;
    if (!body.name?.trim()) {
      await t.rollback();
      return fail(res, 'name is required', 400);
    }

    const files = req.files?.media || [];

    const banner = await PromoBanner.create({
      name: body.name,
      type: body.type || 'image-single',
      page: body.page || 'home',
      position: body.position || 'below-video-testimonials',
      heading: body.heading || null,
      description: body.description || null,
      ctaLabel: body.ctaLabel || null,
      ctaUrl: body.ctaUrl || null,
      heightPx: body.heightPx ? parseInt(body.heightPx, 10) : 360,
      widthMode: body.widthMode || 'container',
      autoplay: body.autoplay === 'false' ? false : true,
      intervalMs: body.intervalMs ? parseInt(body.intervalMs, 10) : 5000,
      isActive: body.isActive === 'false' ? false : true,
      sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
    }, { transaction: t });

    const slidesRaw = parseJsonField(body.slides, []);
    const slideRows = slidesRaw.map((s, idx) => {
      // Resolve __file:N__ placeholders to uploaded file URLs
      let mediaUrl = s.mediaUrl || '';
      const match = /^__file:(\d+)__$/.exec(mediaUrl);
      if (match) {
        const fileIdx = parseInt(match[1], 10);
        if (files[fileIdx]) mediaUrl = buildUrl(files[fileIdx]);
        else mediaUrl = '';
      }
      const mediaType = s.mediaType === 'video' ? 'video' : 'image';
      return {
        bannerId: banner.id,
        mediaType,
        mediaUrl,
        videoProvider: mediaType === 'video' ? (s.videoProvider || detectVideoProvider(mediaUrl)) : null,
        caption: s.caption || null,
        overlayHeading: s.overlayHeading || null,
        overlayText: s.overlayText || null,
        linkUrl: s.linkUrl || null,
        sortOrder: s.sortOrder != null ? parseInt(s.sortOrder, 10) : idx,
      };
    }).filter((s) => s.mediaUrl);

    if (slideRows.length) {
      await PromoBannerSlide.bulkCreate(slideRows, { transaction: t });
    }

    await t.commit();
    const fresh = await PromoBanner.findByPk(banner.id, { include: baseInclude() });
    return created(res, { banner: fresh }, 'Banner created');
  } catch (err) {
    await t.rollback();
    (req.files?.media || []).forEach((f) => removeFileIfLocal(buildUrl(f)));
    throw err;
  }
});

const updateBanner = asyncHandler(async (req, res) => {
  const banner = await PromoBanner.findByPk(req.params.id, {
    include: [{ model: PromoBannerSlide, as: 'slides' }],
  });
  if (!banner) return fail(res, 'Banner not found', 404);

  const body = req.body;
  const files = req.files?.media || [];

  // Direct fields
  ['name', 'heading', 'description', 'ctaLabel', 'ctaUrl', 'type', 'page', 'position', 'widthMode'].forEach((f) => {
    if (body[f] !== undefined) banner[f] = body[f] === '' ? null : body[f];
  });
  if (body.heightPx !== undefined && body.heightPx !== '') banner.heightPx = parseInt(body.heightPx, 10);
  if (body.intervalMs !== undefined && body.intervalMs !== '') banner.intervalMs = parseInt(body.intervalMs, 10);
  if (body.sortOrder !== undefined && body.sortOrder !== '') banner.sortOrder = parseInt(body.sortOrder, 10);
  ['autoplay', 'isActive'].forEach((f) => {
    if (body[f] !== undefined) banner[f] = body[f] === 'true' || body[f] === true;
  });
  await banner.save();

  // Slides — replace strategy. The admin form sends the full ordered list.
  if (body.slides !== undefined) {
    const slidesRaw = parseJsonField(body.slides, []);

    // Existing slides — track which urls we'd be discarding so we can clean
    // up uploaded files that are no longer referenced.
    const incomingUrls = new Set();
    const slideRows = slidesRaw.map((s, idx) => {
      let mediaUrl = s.mediaUrl || '';
      const match = /^__file:(\d+)__$/.exec(mediaUrl);
      if (match) {
        const fileIdx = parseInt(match[1], 10);
        if (files[fileIdx]) mediaUrl = buildUrl(files[fileIdx]);
        else mediaUrl = '';
      }
      incomingUrls.add(mediaUrl);
      const mediaType = s.mediaType === 'video' ? 'video' : 'image';
      return {
        bannerId: banner.id,
        mediaType,
        mediaUrl,
        videoProvider: mediaType === 'video' ? (s.videoProvider || detectVideoProvider(mediaUrl)) : null,
        caption: s.caption || null,
        overlayHeading: s.overlayHeading || null,
        overlayText: s.overlayText || null,
        linkUrl: s.linkUrl || null,
        sortOrder: s.sortOrder != null ? parseInt(s.sortOrder, 10) : idx,
      };
    }).filter((s) => s.mediaUrl);

    // Delete stale uploaded files
    (banner.slides || []).forEach((old) => {
      if (!incomingUrls.has(old.mediaUrl)) {
        removeFileIfLocal(old.mediaUrl);
      }
    });

    await PromoBannerSlide.destroy({ where: { bannerId: banner.id } });
    if (slideRows.length) await PromoBannerSlide.bulkCreate(slideRows);
  }

  const fresh = await PromoBanner.findByPk(banner.id, { include: baseInclude() });
  return ok(res, { banner: fresh }, 'Banner updated');
});

const toggle = asyncHandler(async (req, res) => {
  const item = await PromoBanner.findByPk(req.params.id);
  if (!item) return fail(res, 'Banner not found', 404);
  item.isActive = !item.isActive;
  await item.save();
  return ok(res, { banner: item }, `Banner ${item.isActive ? 'enabled' : 'disabled'}`);
});

const reorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => PromoBanner.update({ sortOrder: idx }, { where: { id } })));
  return ok(res, {}, 'Reordered');
});

const removeBanner = asyncHandler(async (req, res) => {
  const banner = await PromoBanner.findByPk(req.params.id, {
    include: [{ model: PromoBannerSlide, as: 'slides' }],
  });
  if (!banner) return fail(res, 'Banner not found', 404);
  (banner.slides || []).forEach((s) => removeFileIfLocal(s.mediaUrl));
  await banner.destroy();
  return ok(res, {}, 'Banner deleted');
});

const duplicateBanner = asyncHandler(async (req, res) => {
  const original = await PromoBanner.findByPk(req.params.id, { include: baseInclude() });
  if (!original) return fail(res, 'Banner not found', 404);
  const t = await sequelize.transaction();
  try {
    const data = original.toJSON();
    ['id', 'createdAt', 'updatedAt', 'slides'].forEach((k) => delete data[k]);
    const copy = await PromoBanner.create(
      { ...data, name: original.name, isActive: false },
      { transaction: t }
    );
    if (original.slides?.length) {
      await PromoBannerSlide.bulkCreate(
        original.slides.map((s) => ({
          bannerId: copy.id,
          mediaType: s.mediaType,
          mediaUrl: s.mediaUrl,
          videoProvider: s.videoProvider,
          caption: s.caption,
          overlayHeading: s.overlayHeading,
          overlayText: s.overlayText,
          linkUrl: s.linkUrl,
          sortOrder: s.sortOrder,
        })),
        { transaction: t }
      );
    }
    await t.commit();
    const fresh = await PromoBanner.findByPk(copy.id, { include: baseInclude() });
    return created(res, { banner: fresh }, 'Banner duplicated');
  } catch (err) {
    await t.rollback();
    throw err;
  }
});

module.exports = {
  listPublic,
  listAdmin,
  getAdminOne,
  createBanner,
  updateBanner,
  toggle,
  reorder,
  removeBanner,
  duplicateBanner,
};

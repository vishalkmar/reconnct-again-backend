const asyncHandler = require('express-async-handler');
const { Testimonial, TestimonialMedia, sequelize } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

// Coerce FormData strings back into a JSON array (placements multi-select).
const parsePlacements = (raw) => {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }
};

const removeFileIfLocal = (url) => removeUploadedFile(url);
const buildUrl = (file) => getUploadedUrl(file);

const isVideo = (mime, name) =>
  mime?.startsWith('video/') || /\.(mp4|webm|mov|avi)$/i.test(name || '');

// GET /api/testimonials  (public — by type/placement, only active)
const listPublic = asyncHandler(async (req, res) => {
  const where = { isActive: true };
  if (req.query.type) where.type = req.query.type;

  const items = await Testimonial.findAll({
    where,
    include: [{ model: TestimonialMedia, as: 'media' }],
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'DESC'],
      [{ model: TestimonialMedia, as: 'media' }, 'sortOrder', 'ASC'],
    ],
  });

  // Optional in-app placement filter. We do this in JS (not SQL) because the
  // value is stored as a JSON array and we want to keep cross-DB compatibility.
  if (req.query.placement) {
    const wanted = req.query.placement;
    const filtered = items.filter((t) => {
      const placements = Array.isArray(t.placements) ? t.placements : [];
      if (placements.includes(wanted)) return true;
      // Backwards-compat default: an empty placements array falls back to
      // "home_clients_say" for non-video types, and "home_video_band" for
      // video types — preserves existing testimonials without re-tagging.
      if (placements.length === 0) {
        const isVideo = ['video', 'video_text', 'image_video'].includes(t.type);
        return wanted === (isVideo ? 'home_video_band' : 'home_clients_say');
      }
      return false;
    });
    return ok(res, { items: filtered });
  }

  return ok(res, { items });
});

// GET /api/testimonials/placements  (public — list of placement options)
const listPlacements = asyncHandler(async (_req, res) => {
  return ok(res, { items: Testimonial.PLACEMENTS });
});

// GET /api/testimonials/all  (admin)
const listAll = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.type) where.type = req.query.type;
  const items = await Testimonial.findAll({
    where,
    include: [{ model: TestimonialMedia, as: 'media' }],
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'DESC'],
      [{ model: TestimonialMedia, as: 'media' }, 'sortOrder', 'ASC'],
    ],
  });
  return ok(res, { items });
});

// GET /api/testimonials/:id
const getOne = asyncHandler(async (req, res) => {
  const t = await Testimonial.findByPk(req.params.id, {
    include: [{ model: TestimonialMedia, as: 'media' }],
  });
  if (!t) return fail(res, 'Testimonial not found', 404);
  return ok(res, { testimonial: t });
});

// POST /api/testimonials  (multipart: avatar, videoPoster, media[])
const createTestimonial = asyncHandler(async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const body = req.body;
    if (!Testimonial.TYPES.includes(body.type)) {
      await tx.rollback();
      return fail(res, `type must be one of: ${Testimonial.TYPES.join(', ')}`, 400);
    }

    const avatarFile = req.files?.avatar?.[0];
    const posterFile = req.files?.videoPoster?.[0];
    const mediaFiles = req.files?.media || [];

    const t = await Testimonial.create(
      {
        type: body.type,
        authorName: body.authorName || null,
        authorTitle: body.authorTitle || null,
        authorLocation: body.authorLocation || null,
        authorAvatar: avatarFile ? buildUrl(avatarFile) : null,
        rating: body.rating ? parseInt(body.rating, 10) : null,
        content: body.content || null,
        videoUrl: body.videoUrl || null,
        videoPoster: posterFile ? buildUrl(posterFile) : null,
        sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
        isActive: body.isActive === 'false' ? false : true,
        cardWidth: body.cardWidth ? parseInt(body.cardWidth, 10) : null,
        cardHeight: body.cardHeight ? parseInt(body.cardHeight, 10) : null,
        cardPadding: body.cardPadding ? parseInt(body.cardPadding, 10) : null,
        cardMargin: body.cardMargin ? parseInt(body.cardMargin, 10) : null,
        displayMode: Testimonial.DISPLAY_MODES.includes(body.displayMode)
          ? body.displayMode
          : 'carousel',
        placements: parsePlacements(body.placements),
      },
      { transaction: tx }
    );

    if (mediaFiles.length) {
      await TestimonialMedia.bulkCreate(
        mediaFiles.map((f, i) => ({
          testimonialId: t.id,
          url: buildUrl(f),
          mediaType: isVideo(f.mimetype, f.filename) ? 'video' : 'image',
          sortOrder: i,
        })),
        { transaction: tx }
      );
    }

    await tx.commit();
    const fresh = await Testimonial.findByPk(t.id, {
      include: [{ model: TestimonialMedia, as: 'media' }],
    });
    return created(res, { testimonial: fresh }, 'Testimonial created');
  } catch (err) {
    await tx.rollback();
    Object.values(req.files || {}).forEach((arr) =>
      arr.forEach((f) => removeFileIfLocal(buildUrl(f)))
    );
    throw err;
  }
});

// PUT /api/testimonials/:id
const updateTestimonial = asyncHandler(async (req, res) => {
  const t = await Testimonial.findByPk(req.params.id);
  if (!t) return fail(res, 'Testimonial not found', 404);

  const body = req.body;
  if (body.type && !Testimonial.TYPES.includes(body.type))
    return fail(res, `type must be one of: ${Testimonial.TYPES.join(', ')}`, 400);

  ['type', 'authorName', 'authorTitle', 'authorLocation', 'content', 'videoUrl'].forEach((f) => {
    if (body[f] !== undefined) t[f] = body[f] === '' ? null : body[f];
  });

  if (body.rating !== undefined) t.rating = body.rating === '' ? null : parseInt(body.rating, 10);
  if (body.sortOrder !== undefined && body.sortOrder !== '')
    t.sortOrder = parseInt(body.sortOrder, 10);
  if (body.isActive !== undefined) t.isActive = body.isActive === 'true' || body.isActive === true;
  if (body.cardWidth !== undefined)
    t.cardWidth = body.cardWidth === '' ? null : parseInt(body.cardWidth, 10);
  if (body.cardHeight !== undefined)
    t.cardHeight = body.cardHeight === '' ? null : parseInt(body.cardHeight, 10);
  if (body.cardPadding !== undefined)
    t.cardPadding = body.cardPadding === '' ? null : parseInt(body.cardPadding, 10);
  if (body.cardMargin !== undefined)
    t.cardMargin = body.cardMargin === '' ? null : parseInt(body.cardMargin, 10);
  if (body.displayMode !== undefined && Testimonial.DISPLAY_MODES.includes(body.displayMode))
    t.displayMode = body.displayMode;
  if (body.placements !== undefined) t.placements = parsePlacements(body.placements);

  const avatarFile = req.files?.avatar?.[0];
  const posterFile = req.files?.videoPoster?.[0];
  const mediaFiles = req.files?.media || [];

  if (avatarFile) {
    if (t.authorAvatar) removeFileIfLocal(t.authorAvatar);
    t.authorAvatar = buildUrl(avatarFile);
  }
  if (posterFile) {
    if (t.videoPoster) removeFileIfLocal(t.videoPoster);
    t.videoPoster = buildUrl(posterFile);
  }

  await t.save();

  if (mediaFiles.length) {
    if (body.replaceMedia === 'true') {
      const old = await TestimonialMedia.findAll({ where: { testimonialId: t.id } });
      old.forEach((m) => removeFileIfLocal(m.url));
      await TestimonialMedia.destroy({ where: { testimonialId: t.id } });
    }
    const offset = await TestimonialMedia.count({ where: { testimonialId: t.id } });
    await TestimonialMedia.bulkCreate(
      mediaFiles.map((f, i) => ({
        testimonialId: t.id,
        url: buildUrl(f),
        mediaType: isVideo(f.mimetype, f.filename) ? 'video' : 'image',
        sortOrder: offset + i,
      }))
    );
  }

  const fresh = await Testimonial.findByPk(t.id, {
    include: [{ model: TestimonialMedia, as: 'media' }],
  });
  return ok(res, { testimonial: fresh }, 'Testimonial updated');
});

// PATCH /api/testimonials/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const t = await Testimonial.findByPk(req.params.id);
  if (!t) return fail(res, 'Testimonial not found', 404);
  t.isActive = !t.isActive;
  await t.save();
  return ok(res, { testimonial: t }, `Testimonial ${t.isActive ? 'enabled' : 'disabled'}`);
});

// DELETE /api/testimonials/:id
const remove = asyncHandler(async (req, res) => {
  const t = await Testimonial.findByPk(req.params.id, {
    include: [{ model: TestimonialMedia, as: 'media' }],
  });
  if (!t) return fail(res, 'Testimonial not found', 404);

  if (t.authorAvatar) removeFileIfLocal(t.authorAvatar);
  if (t.videoPoster) removeFileIfLocal(t.videoPoster);
  t.media?.forEach((m) => removeFileIfLocal(m.url));

  await t.destroy();
  return ok(res, {}, 'Testimonial deleted');
});

// DELETE /api/testimonials/:id/media/:mediaId
const removeMedia = asyncHandler(async (req, res) => {
  const m = await TestimonialMedia.findOne({
    where: { id: req.params.mediaId, testimonialId: req.params.id },
  });
  if (!m) return fail(res, 'Media not found', 404);
  removeFileIfLocal(m.url);
  await m.destroy();
  return ok(res, {}, 'Media removed');
});

module.exports = {
  listPublic, listPlacements, listAll, getOne,
  createTestimonial, updateTestimonial,
  toggle, remove, removeMedia,
};

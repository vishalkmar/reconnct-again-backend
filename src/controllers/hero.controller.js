const asyncHandler = require('express-async-handler');
const { Hero, HeroMedia, sequelize } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildMediaUrl = (file) => getUploadedUrl(file);

const isVideo = (mime, filename) => {
  if (mime?.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|avi)$/i.test(filename || '');
};

const cleanupFiles = async (files = []) => {
  for (const f of files) {
    const url = getUploadedUrl(f);
    if (url) await removeUploadedFile(url);
  }
};

// GET /api/heroes  (admin) — all heroes
const listAll = asyncHandler(async (req, res) => {
  const { pageKey } = req.query;
  const where = {};
  if (pageKey) where.pageKey = pageKey;

  const heroes = await Hero.findAll({
    where,
    include: [{ model: HeroMedia, as: 'media' }],
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'DESC'],
      [{ model: HeroMedia, as: 'media' }, 'sortOrder', 'ASC'],
    ],
  });
  return ok(res, { heroes });
});

// GET /api/heroes/active?pageKey=home  (public)
const listActiveByPage = asyncHandler(async (req, res) => {
  const pageKey = req.query.pageKey || 'home';
  const heroes = await Hero.findAll({
    where: { pageKey, isActive: true },
    include: [{ model: HeroMedia, as: 'media' }],
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'DESC'],
      [{ model: HeroMedia, as: 'media' }, 'sortOrder', 'ASC'],
    ],
  });
  return ok(res, { heroes });
});

// GET /api/heroes/:id
const getOne = asyncHandler(async (req, res) => {
  const hero = await Hero.findByPk(req.params.id, {
    include: [{ model: HeroMedia, as: 'media' }],
  });
  if (!hero) return fail(res, 'Hero not found', 404);
  return ok(res, { hero });
});

// POST /api/heroes  (multipart with files)
const createHero = asyncHandler(async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const {
      name,
      type,
      pageKey,
      heading,
      subheading,
      ctaLabel,
      ctaUrl,
      textPosition,
      textColor,
      overlayOpacity,
      autoplay,
      intervalMs,
      height,
      isActive,
      sortOrder,
    } = req.body;

    if (!name || !type) {
      cleanupFiles(req.files);
      return fail(res, 'name and type are required', 400);
    }
    if (!Hero.HERO_TYPES.includes(type)) {
      cleanupFiles(req.files);
      return fail(res, `type must be one of: ${Hero.HERO_TYPES.join(', ')}`, 400);
    }

    const hero = await Hero.create(
      {
        name,
        type,
        pageKey: req.body.pageKey || 'home',
        heading: req.body.heading || null,
        subheading: req.body.subheading || null,
        ctaLabel: req.body.ctaLabel || null,
        ctaUrl: req.body.ctaUrl || null,
        textPosition: req.body.textPosition || 'center',
        textColor: req.body.textColor || '#ffffff',
        overlayOpacity:
          req.body.overlayOpacity !== undefined && req.body.overlayOpacity !== ''
            ? parseInt(req.body.overlayOpacity, 10)
            : 35,
        autoplay: req.body.autoplay === 'false' ? false : true,
        intervalMs: req.body.intervalMs ? parseInt(req.body.intervalMs, 10) : 5000,
        height: req.body.height || 'lg',
        widthMode: req.body.widthMode || 'large',
        widthValue: req.body.widthValue ? parseInt(req.body.widthValue, 10) : 100,
        heightValue:
          req.body.heightValue !== undefined && req.body.heightValue !== ''
            ? parseInt(req.body.heightValue, 10)
            : null,
        isActive: req.body.isActive === 'false' ? false : true,
        sortOrder: req.body.sortOrder ? parseInt(req.body.sortOrder, 10) : 0,
      },
      { transaction: t }
    );

    // Files
    if (req.files?.length) {
      const rows = req.files.map((f, i) => ({
        heroId: hero.id,
        url: buildMediaUrl(f),
        mediaType: isVideo(f.mimetype, f.filename) ? 'video' : 'image',
        sortOrder: i,
      }));
      await HeroMedia.bulkCreate(rows, { transaction: t });
    }

    await t.commit();
    const fresh = await Hero.findByPk(hero.id, {
      include: [{ model: HeroMedia, as: 'media' }],
    });
    return created(res, { hero: fresh }, 'Hero created');
  } catch (err) {
    await t.rollback();
    cleanupFiles(req.files);
    throw err;
  }
});

// PUT /api/heroes/:id  (multipart)
const updateHero = asyncHandler(async (req, res) => {
  const hero = await Hero.findByPk(req.params.id);
  if (!hero) {
    cleanupFiles(req.files);
    return fail(res, 'Hero not found', 404);
  }

  const fields = [
    'name',
    'type',
    'pageKey',
    'heading',
    'subheading',
    'ctaLabel',
    'ctaUrl',
    'textPosition',
    'textColor',
    'height',
    'widthMode',
  ];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) hero[f] = req.body[f] === '' ? null : req.body[f];
  });

  if (req.body.overlayOpacity !== undefined && req.body.overlayOpacity !== '')
    hero.overlayOpacity = parseInt(req.body.overlayOpacity, 10);
  if (req.body.intervalMs !== undefined && req.body.intervalMs !== '')
    hero.intervalMs = parseInt(req.body.intervalMs, 10);
  if (req.body.widthValue !== undefined && req.body.widthValue !== '')
    hero.widthValue = parseInt(req.body.widthValue, 10);
  if (req.body.heightValue !== undefined)
    hero.heightValue = req.body.heightValue === '' ? null : parseInt(req.body.heightValue, 10);
  if (req.body.sortOrder !== undefined && req.body.sortOrder !== '')
    hero.sortOrder = parseInt(req.body.sortOrder, 10);
  if (req.body.autoplay !== undefined)
    hero.autoplay = req.body.autoplay === 'true' || req.body.autoplay === true;
  if (req.body.isActive !== undefined)
    hero.isActive = req.body.isActive === 'true' || req.body.isActive === true;

  if (req.body.type && !Hero.HERO_TYPES.includes(req.body.type)) {
    cleanupFiles(req.files);
    return fail(res, `type must be one of: ${Hero.HERO_TYPES.join(', ')}`, 400);
  }

  await hero.save();

  // Optional: replace all media if `replaceMedia=true`, else append
  if (req.files?.length) {
    if (req.body.replaceMedia === 'true') {
      const old = await HeroMedia.findAll({ where: { heroId: hero.id } });
      await Promise.all(old.map((m) => removeUploadedFile(m.url)));
      await HeroMedia.destroy({ where: { heroId: hero.id } });
    }

    const offset = await HeroMedia.count({ where: { heroId: hero.id } });
    const rows = req.files.map((f, i) => ({
      heroId: hero.id,
      url: buildMediaUrl(f),
      mediaType: isVideo(f.mimetype, f.filename) ? 'video' : 'image',
      sortOrder: offset + i,
    }));
    await HeroMedia.bulkCreate(rows);
  }

  const fresh = await Hero.findByPk(hero.id, {
    include: [{ model: HeroMedia, as: 'media' }],
  });
  return ok(res, { hero: fresh }, 'Hero updated');
});

// PATCH /api/heroes/:id/toggle
const toggleActive = asyncHandler(async (req, res) => {
  const hero = await Hero.findByPk(req.params.id);
  if (!hero) return fail(res, 'Hero not found', 404);
  hero.isActive = !hero.isActive;
  await hero.save();
  return ok(res, { hero }, `Hero ${hero.isActive ? 'enabled' : 'disabled'}`);
});

// DELETE /api/heroes/:id
const deleteHero = asyncHandler(async (req, res) => {
  const hero = await Hero.findByPk(req.params.id, {
    include: [{ model: HeroMedia, as: 'media' }],
  });
  if (!hero) return fail(res, 'Hero not found', 404);

  await Promise.all((hero.media || []).map((m) => removeUploadedFile(m.url)));

  await hero.destroy();
  return ok(res, {}, 'Hero deleted');
});

// DELETE /api/heroes/:id/media/:mediaId
const deleteMedia = asyncHandler(async (req, res) => {
  const m = await HeroMedia.findOne({
    where: { id: req.params.mediaId, heroId: req.params.id },
  });
  if (!m) return fail(res, 'Media not found', 404);

  await removeUploadedFile(m.url);
  await m.destroy();
  return ok(res, {}, 'Media removed');
});

// PUT /api/heroes/reorder  body: { order: [id, id, …] }
const reorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);

  await Promise.all(
    order.map((id, idx) => Hero.update({ sortOrder: idx }, { where: { id } }))
  );

  const heroes = await Hero.findAll({
    include: [{ model: HeroMedia, as: 'media' }],
    order: [['sortOrder', 'ASC'], ['id', 'DESC']],
  });
  return ok(res, { heroes }, 'Reordered');
});

module.exports = {
  listAll,
  listActiveByPage,
  getOne,
  createHero,
  updateHero,
  toggleActive,
  deleteHero,
  deleteMedia,
  reorder,
};

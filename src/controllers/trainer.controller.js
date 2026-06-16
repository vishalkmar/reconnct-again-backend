const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const { Trainer, Package, sequelize } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const buildUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

const ensureUniqueSlug = async (base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `trainer-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (
    await Trainer.findOne({
      where: { slug: candidate, ...(ignoreId && { id: { [Op.ne]: ignoreId } }) },
    })
  ) {
    candidate = `${slug}-${i++}`;
    if (i > 50) break;
  }
  return candidate;
};

const parseJsonField = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (Array.isArray(raw) || typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
};

const baseInclude = () => [
  { model: Package, as: 'packages', through: { attributes: [] }, attributes: ['id', 'name', 'slug'] },
];

// GET /api/trainers  (public — only active, simple list for dropdowns / detail pages)
const listPublic = asyncHandler(async (req, res) => {
  const items = await Trainer.findAll({
    where: { isActive: true },
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  return ok(res, { items });
});

// GET /api/trainers/admin/all  (admin — full list)
const listAdmin = asyncHandler(async (req, res) => {
  const items = await Trainer.findAll({
    include: baseInclude(),
    order: [['sortOrder', 'ASC'], ['id', 'DESC']],
  });
  return ok(res, { items });
});

// GET /api/trainers/admin/:id
const getAdminOne = asyncHandler(async (req, res) => {
  const trainer = await Trainer.findByPk(req.params.id, { include: baseInclude() });
  if (!trainer) return fail(res, 'Trainer not found', 404);
  return ok(res, { trainer });
});

// GET /api/trainers/:slug  (public — detail)
const getBySlug = asyncHandler(async (req, res) => {
  const trainer = await Trainer.findOne({
    where: { slug: req.params.slug, isActive: true },
    include: baseInclude(),
  });
  if (!trainer) return fail(res, 'Trainer not found', 404);
  return ok(res, { trainer });
});

// POST /api/trainers   (admin — multipart with `photo`)
const createTrainer = asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body.name?.trim()) return fail(res, 'name is required', 400);

  const slug = await ensureUniqueSlug(body.slug || body.name);
  const photoFile = req.files?.photo?.[0];

  const trainer = await Trainer.create({
    name: body.name,
    slug,
    role: body.role || null,
    experienceYears: body.experienceYears ? parseInt(body.experienceYears, 10) : null,
    specialties: parseJsonField(body.specialties, []),
    languages: parseJsonField(body.languages, []),
    certifications: parseJsonField(body.certifications, []),
    socials: parseJsonField(body.socials, {}),
    photo: photoFile ? buildUrl(photoFile) : null,
    bioRich: body.bioRich || null,
    shortBio: body.shortBio || null,
    isFeatured: body.isFeatured === 'true',
    isActive: body.isActive === 'false' ? false : true,
    sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
  });

  const fresh = await Trainer.findByPk(trainer.id, { include: baseInclude() });
  return created(res, { trainer: fresh }, 'Trainer created');
});

// PUT /api/trainers/:id  (admin)
const updateTrainer = asyncHandler(async (req, res) => {
  const trainer = await Trainer.findByPk(req.params.id);
  if (!trainer) return fail(res, 'Trainer not found', 404);

  const body = req.body;
  const photoFile = req.files?.photo?.[0];

  if (body.name !== undefined) trainer.name = body.name;
  if (body.slug !== undefined && body.slug !== trainer.slug) {
    trainer.slug = await ensureUniqueSlug(body.slug, trainer.id);
  }

  ['role', 'bioRich', 'shortBio'].forEach((f) => {
    if (body[f] !== undefined) trainer[f] = body[f] === '' ? null : body[f];
  });

  if (body.experienceYears !== undefined)
    trainer.experienceYears = body.experienceYears === '' ? null : parseInt(body.experienceYears, 10);

  if (body.sortOrder !== undefined && body.sortOrder !== '')
    trainer.sortOrder = parseInt(body.sortOrder, 10);

  if (body.specialties !== undefined) trainer.specialties = parseJsonField(body.specialties, []);
  if (body.languages !== undefined) trainer.languages = parseJsonField(body.languages, []);
  if (body.certifications !== undefined) trainer.certifications = parseJsonField(body.certifications, []);
  if (body.socials !== undefined) trainer.socials = parseJsonField(body.socials, {});

  ['isFeatured', 'isActive'].forEach((f) => {
    if (body[f] !== undefined) trainer[f] = body[f] === 'true' || body[f] === true;
  });

  if (photoFile) {
    if (trainer.photo) removeFileIfLocal(trainer.photo);
    trainer.photo = buildUrl(photoFile);
  }

  await trainer.save();

  const fresh = await Trainer.findByPk(trainer.id, { include: baseInclude() });
  return ok(res, { trainer: fresh }, 'Trainer updated');
});

// POST /api/trainers/:id/duplicate  (admin)
const duplicateTrainer = asyncHandler(async (req, res) => {
  const original = await Trainer.findByPk(req.params.id);
  if (!original) return fail(res, 'Trainer not found', 404);

  const data = original.toJSON();
  const slug = await ensureUniqueSlug(`${data.slug}-copy`);
  ['id', 'slug', 'createdAt', 'updatedAt'].forEach((k) => delete data[k]);

  const copy = await Trainer.create({
    ...data,
    name: original.name,
    slug,
    isActive: false,
    isFeatured: false,
  });

  const fresh = await Trainer.findByPk(copy.id, { include: baseInclude() });
  return created(res, { trainer: fresh }, 'Trainer duplicated');
});

// PATCH /api/trainers/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const trainer = await Trainer.findByPk(req.params.id);
  if (!trainer) return fail(res, 'Trainer not found', 404);
  trainer.isActive = !trainer.isActive;
  await trainer.save();
  return ok(res, { trainer }, `Trainer ${trainer.isActive ? 'enabled' : 'disabled'}`);
});

// PUT /api/trainers/admin/reorder  body: { order: [id, id, …] }
const reorderTrainers = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);
  await Promise.all(order.map((id, idx) => Trainer.update({ sortOrder: idx }, { where: { id } })));
  return ok(res, {}, 'Reordered');
});

// DELETE /api/trainers/:id
const removeTrainer = asyncHandler(async (req, res) => {
  const trainer = await Trainer.findByPk(req.params.id);
  if (!trainer) return fail(res, 'Trainer not found', 404);
  if (trainer.photo) removeFileIfLocal(trainer.photo);
  await trainer.destroy();
  return ok(res, {}, 'Trainer deleted');
});

module.exports = {
  listPublic,
  listAdmin,
  getAdminOne,
  getBySlug,
  createTrainer,
  updateTrainer,
  duplicateTrainer,
  toggle,
  reorderTrainers,
  removeTrainer,
};

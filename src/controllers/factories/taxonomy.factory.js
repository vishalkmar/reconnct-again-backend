const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { ok, created, fail } = require('../../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../../utils/uploads');

const buildImageUrl = (file) => getUploadedUrl(file);
const removeFileIfLocal = (url) => removeUploadedFile(url);

const ensureUniqueSlug = async (Model, base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `item-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (await Model.findOne({ where: { slug: candidate, ...(ignoreId && { id: { [require('sequelize').Op.ne]: ignoreId } }) } })) {
    candidate = `${slug}-${i++}`;
    if (i > 50) break;
  }
  return candidate;
};

/**
 * Build a generic CRUD controller for a Sequelize "taxonomy" model
 * (City, Category, Problem, Activity, etc.) that all share:
 *   id, name, slug, imageUrl, description, sortOrder, isActive
 *
 * The `extraFields` array lists any additional simple string fields
 * (like `country` on City, or `icon` on Problem/Activity).
 */
const buildTaxonomyController = ({ Model, subfolder, label = 'Item', extraFields = [] }) => {
  // GET /  (public — only active, sorted)
  const listPublic = asyncHandler(async (req, res) => {
    const items = await Model.findAll({
      where: { isActive: true },
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    });
    return ok(res, { items });
  });

  // GET /all  (admin)
  const listAll = asyncHandler(async (req, res) => {
    const items = await Model.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
    return ok(res, { items });
  });

  // GET /:id
  const getOne = asyncHandler(async (req, res) => {
    const item = await Model.findByPk(req.params.id);
    if (!item) return fail(res, `${label} not found`, 404);
    return ok(res, { item });
  });

  // POST /
  const create = asyncHandler(async (req, res) => {
    const { name, description, sortOrder, isActive } = req.body;
    if (!name) {
      if (req.file) removeFileIfLocal(buildImageUrl(req.file));
      return fail(res, 'name is required', 400);
    }

    const data = {
      name,
      slug: await ensureUniqueSlug(Model, req.body.slug || name),
      description: description || null,
      sortOrder: sortOrder !== undefined && sortOrder !== '' ? parseInt(sortOrder, 10) : 0,
      isActive: isActive === 'false' ? false : true,
      imageUrl: req.file ? buildImageUrl(req.file) : null,
    };
    extraFields.forEach((f) => {
      if (req.body[f] !== undefined) data[f] = req.body[f] || null;
    });

    const item = await Model.create(data);
    return created(res, { item }, `${label} created`);
  });

  // PUT /:id
  const update = asyncHandler(async (req, res) => {
    const item = await Model.findByPk(req.params.id);
    if (!item) {
      if (req.file) removeFileIfLocal(buildImageUrl(req.file));
      return fail(res, `${label} not found`, 404);
    }

    if (req.body.name !== undefined) item.name = req.body.name;
    if (req.body.slug !== undefined && req.body.slug !== item.slug) {
      item.slug = await ensureUniqueSlug(Model, req.body.slug, item.id);
    }
    if (req.body.description !== undefined) item.description = req.body.description || null;
    if (req.body.sortOrder !== undefined && req.body.sortOrder !== '')
      item.sortOrder = parseInt(req.body.sortOrder, 10);
    if (req.body.isActive !== undefined)
      item.isActive = req.body.isActive === 'true' || req.body.isActive === true;
    extraFields.forEach((f) => {
      if (req.body[f] !== undefined) item[f] = req.body[f] || null;
    });

    if (req.file) {
      if (item.imageUrl) removeFileIfLocal(item.imageUrl);
      item.imageUrl = buildImageUrl(req.file);
    }

    await item.save();
    return ok(res, { item }, `${label} updated`);
  });

  // PATCH /:id/toggle
  const toggle = asyncHandler(async (req, res) => {
    const item = await Model.findByPk(req.params.id);
    if (!item) return fail(res, `${label} not found`, 404);
    item.isActive = !item.isActive;
    await item.save();
    return ok(res, { item }, `${label} ${item.isActive ? 'enabled' : 'disabled'}`);
  });

  // DELETE /:id
  const remove = asyncHandler(async (req, res) => {
    const item = await Model.findByPk(req.params.id);
    if (!item) return fail(res, `${label} not found`, 404);
    if (item.imageUrl) removeFileIfLocal(item.imageUrl);
    await item.destroy();
    return ok(res, {}, `${label} deleted`);
  });

  // PUT /reorder  body: { order: [id, id, …] }
  const reorder = asyncHandler(async (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return fail(res, 'order must be an array of ids', 400);

    await Promise.all(
      order.map((id, idx) => Model.update({ sortOrder: idx }, { where: { id } }))
    );

    const items = await Model.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
    return ok(res, { items }, 'Reordered');
  });

  return { listPublic, listAll, getOne, create, update, toggle, remove, reorder };
};

module.exports = { buildTaxonomyController };

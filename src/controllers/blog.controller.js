const asyncHandler = require('express-async-handler');
const slugify = require('slugify');
const { Op } = require('sequelize');
const { Blog, BlogCategory, BlogScene } = require('../models');
const { ok, created, fail } = require('../utils/response');
const { getUploadedUrl, removeUploadedFile } = require('../utils/uploads');

const removeFileIfLocal = (url) => removeUploadedFile(url);
const buildUrl = (file) => getUploadedUrl(file);

const ensureUniqueSlug = async (base, ignoreId = null) => {
  let slug = slugify(base, { lower: true, strict: true });
  if (!slug) slug = `blog-${Date.now()}`;
  let candidate = slug;
  let i = 1;
  while (
    await Blog.findOne({
      where: { slug: candidate, ...(ignoreId && { id: { [Op.ne]: ignoreId } }) },
    })
  ) {
    candidate = `${slug}-${i++}`;
    if (i > 50) break;
  }
  return candidate;
};

const parseTags = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

// GET /api/blogs   (public — published only, with filters)
const listPublic = asyncHandler(async (req, res) => {
  const { category, tag, search, featured, page = 1, limit = 12 } = req.query;

  const where = { isPublished: true };
  if (search) {
    where[Op.or] = [
      { title: { [Op.like]: `%${search}%` } },
      { excerpt: { [Op.like]: `%${search}%` } },
    ];
  }
  if (featured === 'true') where.isFeatured = true;
  if (tag) where.tags = { [Op.like]: `%"${tag}"%` };

  const include = [
    {
      model: BlogCategory, as: 'category',
      ...(category && { where: { slug: category }, required: true }),
    },
  ];

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const { rows, count } = await Blog.findAndCountAll({
    where,
    include,
    order: [['publishedAt', 'DESC'], ['id', 'DESC']],
    limit: parseInt(limit, 10),
    offset,
    distinct: true,
  });

  return ok(res, {
    items: rows,
    pagination: {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      total: count,
      pages: Math.ceil(count / parseInt(limit, 10)),
    },
  });
});

// GET /api/blogs/:slug  (public)
const getBySlug = asyncHandler(async (req, res) => {
  const blog = await Blog.findOne({
    where: { slug: req.params.slug, isPublished: true },
    include: [
      { model: BlogCategory, as: 'category' },
      { model: BlogScene, as: 'scenes' },
    ],
    order: [[{ model: BlogScene, as: 'scenes' }, 'sortOrder', 'ASC']],
  });
  if (!blog) return fail(res, 'Blog not found', 404);

  // bump view count
  blog.viewCount = (blog.viewCount || 0) + 1;
  await blog.save();

  // Related (3 latest in same category, excluding self)
  const related = await Blog.findAll({
    where: {
      isPublished: true,
      id: { [Op.ne]: blog.id },
      ...(blog.blogCategoryId && { blogCategoryId: blog.blogCategoryId }),
    },
    limit: 3,
    order: [['publishedAt', 'DESC']],
    include: [{ model: BlogCategory, as: 'category' }],
  });

  return ok(res, { blog, related });
});

// GET /api/blogs/admin/all
const listAdmin = asyncHandler(async (req, res) => {
  const items = await Blog.findAll({
    include: [{ model: BlogCategory, as: 'category' }],
    order: [['createdAt', 'DESC']],
  });
  return ok(res, { items });
});

// GET /api/blogs/admin/:id
const getAdminOne = asyncHandler(async (req, res) => {
  const blog = await Blog.findByPk(req.params.id, {
    include: [
      { model: BlogCategory, as: 'category' },
      { model: BlogScene, as: 'scenes' },
    ],
    order: [[{ model: BlogScene, as: 'scenes' }, 'sortOrder', 'ASC']],
  });
  if (!blog) return fail(res, 'Blog not found', 404);
  return ok(res, { blog });
});

// =================== SCENES ===================

// GET /api/blogs/:blogId/scenes  (admin)
const listScenes = asyncHandler(async (req, res) => {
  const scenes = await BlogScene.findAll({
    where: { blogId: req.params.blogId },
    order: [['sortOrder', 'ASC'], ['id', 'ASC']],
  });
  return ok(res, { scenes });
});

// POST /api/blogs/:blogId/scenes  (multipart: image)
const createScene = asyncHandler(async (req, res) => {
  const blog = await Blog.findByPk(req.params.blogId);
  if (!blog) return fail(res, 'Blog not found', 404);

  const file = req.file;
  const body = req.body;
  const count = await BlogScene.count({ where: { blogId: blog.id } });

  const scene = await BlogScene.create({
    blogId: blog.id,
    title: body.title || null,
    subtitle: body.subtitle || null,
    content: body.content || null,
    imageUrl: file ? buildUrl(file) : null,
    imagePosition: body.imagePosition || 'left',
    sortOrder: body.sortOrder !== undefined ? parseInt(body.sortOrder, 10) : count,
  });

  return created(res, { scene }, 'Scene created');
});

// PUT /api/blogs/:blogId/scenes/:sceneId
const updateScene = asyncHandler(async (req, res) => {
  const scene = await BlogScene.findOne({
    where: { id: req.params.sceneId, blogId: req.params.blogId },
  });
  if (!scene) return fail(res, 'Scene not found', 404);

  const body = req.body;
  ['title', 'subtitle', 'content', 'imagePosition'].forEach((f) => {
    if (body[f] !== undefined) scene[f] = body[f] === '' ? null : body[f];
  });
  if (body.sortOrder !== undefined && body.sortOrder !== '')
    scene.sortOrder = parseInt(body.sortOrder, 10);

  if (req.file) {
    if (scene.imageUrl) await removeUploadedFile(scene.imageUrl);
    scene.imageUrl = buildUrl(req.file);
  }

  await scene.save();
  return ok(res, { scene }, 'Scene updated');
});

// DELETE /api/blogs/:blogId/scenes/:sceneId
const removeScene = asyncHandler(async (req, res) => {
  const scene = await BlogScene.findOne({
    where: { id: req.params.sceneId, blogId: req.params.blogId },
  });
  if (!scene) return fail(res, 'Scene not found', 404);
  if (scene.imageUrl) await removeUploadedFile(scene.imageUrl);
  await scene.destroy();
  return ok(res, {}, 'Scene deleted');
});

// PUT /api/blogs/:blogId/scenes/reorder  body: { order: [id, id, ...] }
const reorderScenes = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return fail(res, 'order must be an array', 400);
  await Promise.all(
    order.map((id, idx) =>
      BlogScene.update(
        { sortOrder: idx },
        { where: { id, blogId: req.params.blogId } }
      )
    )
  );
  return ok(res, {}, 'Reordered');
});

// POST /api/blogs  (multipart: featuredImage + authorImage)
const createBlog = asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body.title?.trim()) return fail(res, 'title is required', 400);

  const featured = req.files?.featuredImage?.[0];
  const authorImg = req.files?.authorImage?.[0];

  const slug = await ensureUniqueSlug(body.slug || body.title);

  const isPublished = body.isPublished === 'true' || body.isPublished === true;

  const blog = await Blog.create({
    title: body.title,
    slug,
    excerpt: body.excerpt || null,
    content: body.content || null,
    featuredImage: featured ? buildUrl(featured) : null,
    blogCategoryId: body.blogCategoryId ? parseInt(body.blogCategoryId, 10) : null,
    authorName: body.authorName || null,
    authorTitle: body.authorTitle || null,
    authorImage: authorImg ? buildUrl(authorImg) : null,
    tags: parseTags(body.tags),
    readMinutes: body.readMinutes ? parseInt(body.readMinutes, 10) : 5,
    isFeatured: body.isFeatured === 'true' || body.isFeatured === true,
    isPublished,
    publishedAt: isPublished ? new Date() : null,
    metaTitle: body.metaTitle || null,
    metaDescription: body.metaDescription || null,
    sortOrder: body.sortOrder ? parseInt(body.sortOrder, 10) : 0,
  });

  return created(res, { blog }, 'Blog created');
});

// PUT /api/blogs/:id
const updateBlog = asyncHandler(async (req, res) => {
  const blog = await Blog.findByPk(req.params.id);
  if (!blog) return fail(res, 'Blog not found', 404);

  const body = req.body;

  if (body.title !== undefined) blog.title = body.title;
  if (body.slug !== undefined && body.slug !== blog.slug) {
    blog.slug = await ensureUniqueSlug(body.slug, blog.id);
  }
  ['excerpt', 'content', 'authorName', 'authorTitle', 'metaTitle', 'metaDescription'].forEach((f) => {
    if (body[f] !== undefined) blog[f] = body[f] === '' ? null : body[f];
  });

  if (body.blogCategoryId !== undefined)
    blog.blogCategoryId = body.blogCategoryId === '' ? null : parseInt(body.blogCategoryId, 10);
  if (body.readMinutes !== undefined && body.readMinutes !== '')
    blog.readMinutes = parseInt(body.readMinutes, 10);
  if (body.sortOrder !== undefined && body.sortOrder !== '')
    blog.sortOrder = parseInt(body.sortOrder, 10);
  if (body.tags !== undefined) blog.tags = parseTags(body.tags);
  if (body.isFeatured !== undefined)
    blog.isFeatured = body.isFeatured === 'true' || body.isFeatured === true;

  if (body.isPublished !== undefined) {
    const wasPublished = blog.isPublished;
    blog.isPublished = body.isPublished === 'true' || body.isPublished === true;
    if (blog.isPublished && !wasPublished) blog.publishedAt = new Date();
  }

  const featured = req.files?.featuredImage?.[0];
  const authorImg = req.files?.authorImage?.[0];

  if (featured) {
    if (blog.featuredImage) removeFileIfLocal(blog.featuredImage);
    blog.featuredImage = buildUrl(featured);
  }
  if (authorImg) {
    if (blog.authorImage) removeFileIfLocal(blog.authorImage);
    blog.authorImage = buildUrl(authorImg);
  }

  await blog.save();
  const fresh = await Blog.findByPk(blog.id, { include: [{ model: BlogCategory, as: 'category' }] });
  return ok(res, { blog: fresh }, 'Blog updated');
});

// POST /api/blogs/:id/duplicate  (admin)
const duplicateBlog = asyncHandler(async (req, res) => {
  const original = await Blog.findByPk(req.params.id, {
    include: [{ model: BlogScene, as: 'scenes' }],
    order: [[{ model: BlogScene, as: 'scenes' }, 'sortOrder', 'ASC']],
  });
  if (!original) return fail(res, 'Blog not found', 404);

  const data = original.toJSON();
  const slug = await ensureUniqueSlug(`${data.slug}-copy`);

  ['id', 'slug', 'createdAt', 'updatedAt', 'viewCount', 'publishedAt', 'scenes'].forEach((k) => delete data[k]);

  const copy = await Blog.create({
    ...data,
    title: original.title,
    slug,
    isPublished: false,
    isFeatured: false,
    publishedAt: null,
  });

  // Duplicate scenes pointing at the same uploaded image URLs
  if (original.scenes?.length) {
    await BlogScene.bulkCreate(
      original.scenes.map((s, i) => ({
        blogId: copy.id,
        title: s.title,
        subtitle: s.subtitle,
        content: s.content,
        imageUrl: s.imageUrl,
        imagePosition: s.imagePosition,
        sortOrder: i,
      }))
    );
  }

  return created(res, { blog: copy }, 'Blog duplicated');
});

// PATCH /api/blogs/:id/toggle  (toggle isPublished)
const toggle = asyncHandler(async (req, res) => {
  const blog = await Blog.findByPk(req.params.id);
  if (!blog) return fail(res, 'Blog not found', 404);
  blog.isPublished = !blog.isPublished;
  if (blog.isPublished && !blog.publishedAt) blog.publishedAt = new Date();
  await blog.save();
  return ok(res, { blog }, `Blog ${blog.isPublished ? 'published' : 'unpublished'}`);
});

// DELETE /api/blogs/:id
const removeBlog = asyncHandler(async (req, res) => {
  const blog = await Blog.findByPk(req.params.id);
  if (!blog) return fail(res, 'Blog not found', 404);
  if (blog.featuredImage) removeFileIfLocal(blog.featuredImage);
  if (blog.authorImage) removeFileIfLocal(blog.authorImage);
  await blog.destroy();
  return ok(res, {}, 'Blog deleted');
});

module.exports = {
  listPublic, getBySlug,
  listAdmin, getAdminOne,
  createBlog, updateBlog,
  duplicateBlog,
  toggle, removeBlog,
  listScenes, createScene, updateScene, removeScene, reorderScenes,
};

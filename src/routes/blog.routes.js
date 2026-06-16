const router = require('express').Router();
const ctrl = require('../controllers/blog.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('blogs');
const sceneUpload = buildUploader('blog-scenes');
const blogUpload = upload.fields([
  { name: 'featuredImage', maxCount: 1 },
  { name: 'authorImage', maxCount: 1 },
]);

// Public
router.get('/', ctrl.listPublic);

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, blogUpload, ctrl.createBlog);
router.put('/:id', authenticate, blogUpload, ctrl.updateBlog);
router.post('/:id/duplicate', authenticate, ctrl.duplicateBlog);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id', authenticate, ctrl.removeBlog);

// Scenes (admin)
router.get('/:blogId/scenes', authenticate, ctrl.listScenes);
router.post('/:blogId/scenes', authenticate, sceneUpload.single('image'), ctrl.createScene);
router.put('/:blogId/scenes/reorder', authenticate, ctrl.reorderScenes);
router.put('/:blogId/scenes/:sceneId', authenticate, sceneUpload.single('image'), ctrl.updateScene);
router.delete('/:blogId/scenes/:sceneId', authenticate, ctrl.removeScene);

// Public — by slug (last to avoid clashes)
router.get('/:slug', ctrl.getBySlug);

module.exports = router;

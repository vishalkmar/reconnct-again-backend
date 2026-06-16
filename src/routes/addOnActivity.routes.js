const router = require('express').Router();
const ctrl = require('../controllers/addOnActivity.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('add-ons');

const activityUpload = upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'gallery', maxCount: 30 },
]);

// Public
router.get('/', ctrl.listPublic);

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorder);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, activityUpload, ctrl.createActivity);
router.put('/:id', authenticate, activityUpload, ctrl.updateActivity);
router.post('/:id/duplicate', authenticate, ctrl.duplicateActivity);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id/gallery/:imageId', authenticate, ctrl.removeGalleryImage);
router.delete('/:id', authenticate, ctrl.removeActivity);

// Public — fetch by slug (last)
router.get('/:slug', ctrl.getBySlug);

module.exports = router;

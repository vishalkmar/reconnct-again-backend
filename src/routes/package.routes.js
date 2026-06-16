const router = require('express').Router();
const ctrl = require('../controllers/package.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('packages');

const packageUpload = upload.fields([
  { name: 'primaryImage', maxCount: 1 },
  { name: 'hostImage', maxCount: 1 },
  { name: 'gallery', maxCount: 30 },
]);

// Public
router.get('/', ctrl.listPublic);
router.get('/price-stats', ctrl.priceStats); // must be before /:slug
router.post('/:id/interested', ctrl.markInterested);
router.post('/:id/check-availability', ctrl.submitAvailabilityRequest);
// Legacy review-submission alias (forwards into the unified /api/reviews flow)
router.post('/:id/reviews', ctrl.submitReview);

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorderPackages);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, packageUpload, ctrl.createPackage);
router.put('/:id', authenticate, packageUpload, ctrl.updatePackage);
router.post('/:id/duplicate', authenticate, ctrl.duplicatePackage);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id/gallery/:imageId', authenticate, ctrl.removeGalleryImage);
router.delete('/:id', authenticate, ctrl.removePackage);

// Public — fetch by slug (must be last to avoid clashing with /admin etc)
router.get('/:slug', ctrl.getBySlug);

module.exports = router;

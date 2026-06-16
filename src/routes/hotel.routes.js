const router = require('express').Router();
const ctrl = require('../controllers/hotel.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('hotels');

const hotelUpload = upload.fields([
  { name: 'primaryImage', maxCount: 1 },
  { name: 'gallery', maxCount: 30 },
]);

// Public
router.get('/', ctrl.listPublic);
router.get('/price-stats', ctrl.priceStats); // must be before /:slug

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorderHotels);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, hotelUpload, ctrl.createHotel);
router.put('/:id', authenticate, hotelUpload, ctrl.updateHotel);
router.post('/:id/duplicate', authenticate, ctrl.duplicateHotel);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id/gallery/:imageId', authenticate, ctrl.removeGalleryImage);
router.delete('/:id', authenticate, ctrl.removeHotel);

// Public — fetch by slug (last to avoid clashing with /admin etc.)
router.get('/:slug', ctrl.getBySlug);

module.exports = router;

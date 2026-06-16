const router = require('express').Router();
const ctrl = require('../controllers/promoBanner.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('promo-banners');
// Accept up to 20 media files in a single `media[]` field.
const bannerUpload = upload.fields([{ name: 'media', maxCount: 20 }]);

// Public
router.get('/', ctrl.listPublic);

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorder);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, bannerUpload, ctrl.createBanner);
router.put('/:id', authenticate, bannerUpload, ctrl.updateBanner);
router.post('/:id/duplicate', authenticate, ctrl.duplicateBanner);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id', authenticate, ctrl.removeBanner);

module.exports = router;

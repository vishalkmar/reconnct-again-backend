const router = require('express').Router();
const ctrl = require('../controllers/availableRoom.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('rooms');

const roomUpload = upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'gallery', maxCount: 30 },
]);

// Public
router.get('/', ctrl.listPublicByHotel);            // ?hotelSlug=… or ?hotelId=…
router.get('/by-package', ctrl.listPublicByPackage); // ?packageSlug=… or ?packageId=…
router.get('/by-slug', ctrl.getBySlug);             // ?hotelSlug=…&roomSlug=…

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorderRooms);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, roomUpload, ctrl.createRoom);
router.put('/:id', authenticate, roomUpload, ctrl.updateRoom);
router.post('/:id/duplicate', authenticate, ctrl.duplicateRoom);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id/gallery/:imageId', authenticate, ctrl.removeGalleryImage);
router.delete('/:id', authenticate, ctrl.removeRoom);

module.exports = router;

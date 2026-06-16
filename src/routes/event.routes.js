const router = require('express').Router();
const ctrl = require('../controllers/event.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('events');

const eventUpload = upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'gallery', maxCount: 30 },
]);

// Public
router.get('/', ctrl.listPublic);
router.get('/price-stats', ctrl.priceStats); // must be before /:slug

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorder);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, eventUpload, ctrl.createEvent);
router.put('/:id', authenticate, eventUpload, ctrl.updateEvent);
router.post('/:id/duplicate', authenticate, ctrl.duplicateEvent);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id/gallery/:imageId', authenticate, ctrl.removeGalleryImage);
router.delete('/:id', authenticate, ctrl.removeEvent);

// Slots
router.get('/:eventId/slots', ctrl.listSlots);                          // public
router.post('/:eventId/slots', authenticate, ctrl.createSlots);         // admin bulk create
router.put('/slots/:slotId', authenticate, ctrl.updateSlot);            // admin
router.delete('/slots/:slotId', authenticate, ctrl.removeSlot);         // admin
router.post('/slots/:slotId/book', ctrl.bookSlot);                      // public

// Public detail by slug (must be last)
router.get('/:slug', ctrl.getBySlug);

module.exports = router;

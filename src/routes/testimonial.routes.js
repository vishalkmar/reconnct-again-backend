const router = require('express').Router();
const ctrl = require('../controllers/testimonial.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('testimonials');

const testimonialUpload = upload.fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'videoPoster', maxCount: 1 },
  { name: 'media', maxCount: 30 },
]);

// Public
router.get('/', ctrl.listPublic);
router.get('/placements', ctrl.listPlacements);

// Admin
router.get('/all', authenticate, ctrl.listAll);
router.get('/:id', authenticate, ctrl.getOne);
router.post('/', authenticate, testimonialUpload, ctrl.createTestimonial);
router.put('/:id', authenticate, testimonialUpload, ctrl.updateTestimonial);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id/media/:mediaId', authenticate, ctrl.removeMedia);
router.delete('/:id', authenticate, ctrl.remove);

module.exports = router;

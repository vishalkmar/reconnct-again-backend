const router = require('express').Router();
const ctrl = require('../controllers/trainer.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('trainers');
const trainerUpload = upload.fields([{ name: 'photo', maxCount: 1 }]);

// Public
router.get('/', ctrl.listPublic);

// Admin
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorderTrainers);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, trainerUpload, ctrl.createTrainer);
router.put('/:id', authenticate, trainerUpload, ctrl.updateTrainer);
router.post('/:id/duplicate', authenticate, ctrl.duplicateTrainer);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id', authenticate, ctrl.removeTrainer);

// Public detail (must come last to avoid clashing with /admin etc)
router.get('/:slug', ctrl.getBySlug);

module.exports = router;

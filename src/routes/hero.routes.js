const router = require('express').Router();
const ctrl = require('../controllers/hero.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('heroes');

// Public
router.get('/active', ctrl.listActiveByPage);

// Admin
router.get('/', authenticate, ctrl.listAll);
router.put('/reorder', authenticate, ctrl.reorder); // before /:id
router.get('/:id', authenticate, ctrl.getOne);
router.post('/', authenticate, upload.array('media', 20), ctrl.createHero);
router.put('/:id', authenticate, upload.array('media', 20), ctrl.updateHero);
router.patch('/:id/toggle', authenticate, ctrl.toggleActive);
router.delete('/:id/media/:mediaId', authenticate, ctrl.deleteMedia);
router.delete('/:id', authenticate, ctrl.deleteHero);

module.exports = router;

const { Router } = require('express');
const ctrl = require('../controllers/eventType.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const router = Router();
const upload = buildUploader('event-types');

router.get('/', ctrl.listPublic);
router.get('/all', authenticate, ctrl.listAll);
router.put('/reorder', authenticate, ctrl.reorder);
router.get('/:id', authenticate, ctrl.getOne);
router.post('/', authenticate, upload.single('image'), ctrl.create);
router.put('/:id', authenticate, upload.single('image'), ctrl.update);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id', authenticate, ctrl.remove);

module.exports = router;

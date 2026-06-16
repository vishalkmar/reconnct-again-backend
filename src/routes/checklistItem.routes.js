const router = require('express').Router();
const ctrl = require('../controllers/checklistItem.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('checklist');
const iconUpload = upload.fields([{ name: 'icon', maxCount: 1 }]);

router.get('/', ctrl.listPublic);

router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorderItems);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, iconUpload, ctrl.createItem);
router.put('/:id', authenticate, iconUpload, ctrl.updateItem);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id', authenticate, ctrl.removeItem);

module.exports = router;

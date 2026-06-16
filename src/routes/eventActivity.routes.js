const router = require('express').Router();
const ctrl = require('../controllers/eventActivity.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// Public
router.get('/', ctrl.listPublic);

// Admin (media are instant-upload URLs in the JSON body — no multer needed)
router.get('/admin/all', authenticate, ctrl.listAdmin);
router.put('/admin/reorder', authenticate, ctrl.reorder);
router.get('/admin/:id', authenticate, ctrl.getAdminOne);
router.post('/', authenticate, ctrl.create);
router.put('/:id', authenticate, ctrl.update);
router.post('/:id/duplicate', authenticate, ctrl.duplicate);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id', authenticate, ctrl.remove);

// Public — by slug (last so it doesn't shadow /admin)
router.get('/:slug', ctrl.getBySlug);

module.exports = router;

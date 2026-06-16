const router = require('express').Router();
const ctrl = require('../controllers/review.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// Public
router.get('/', ctrl.listForEntityPublic);
router.get('/featured', ctrl.listFeaturedPublic);
router.post('/', ctrl.submit);

// Admin
router.get('/admin/list', authenticate, ctrl.listAdmin);
router.patch('/:id/approve', authenticate, ctrl.toggleApprove);
router.delete('/:id', authenticate, ctrl.remove);

module.exports = router;

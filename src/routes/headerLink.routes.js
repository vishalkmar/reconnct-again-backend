const router = require('express').Router();
const ctrl = require('../controllers/headerLink.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// Public
router.get('/', ctrl.listPublic);

// Admin
router.get('/all', authenticate, ctrl.listAll);
router.post('/', authenticate, ctrl.createLink);
router.put('/reorder', authenticate, ctrl.reorder);
router.put('/:id', authenticate, ctrl.updateLink);
router.patch('/:id/toggle', authenticate, ctrl.toggle);
router.delete('/:id', authenticate, ctrl.deleteLink);

module.exports = router;

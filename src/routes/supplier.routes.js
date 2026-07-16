const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateStaff, requireStaffPermission } = require('../middlewares/staffAuth.middleware');
const c = require('../controllers/supplier.controller');

// List/view/create — admin OR a team member (BD) with canCreateSupplier.
router.get('/', authenticateStaff, c.list);
router.get('/:id', authenticateStaff, c.getOne);
router.post('/', authenticateStaff, requireStaffPermission('canCreateSupplier'), c.create);

// Edit/disable/delete stay admin-only — not part of what BD was granted.
router.put('/:id', authenticate, c.update);
router.patch('/:id/toggle', authenticate, c.toggle);
router.delete('/:id', authenticate, c.remove);

module.exports = router;

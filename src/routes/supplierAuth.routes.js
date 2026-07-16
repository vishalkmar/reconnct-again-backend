const router = require('express').Router();
const { authenticateSupplier } = require('../middlewares/supplierAuth.middleware');
const c = require('../controllers/supplierAuth.controller');

// Mounted at /api/supplier/auth — a supplier's own sign-in, separate from
// admin/user/team-member auth.
router.post('/login', c.login);
router.get('/me', authenticateSupplier, c.me);

module.exports = router;

const router = require('express').Router();
const { authenticateSupplier } = require('../middlewares/supplierAuth.middleware');
const { credentialLimiter, requestLinkLimiter } = require('../middlewares/rateLimit.middleware');
const c = require('../controllers/supplierAuth.controller');

// Mounted at /api/supplier/auth — a supplier's own sign-in, separate from
// admin/user/team-member auth.
router.post('/login', credentialLimiter, c.login);
router.post('/forgot-password', requestLinkLimiter, c.forgotPassword);
router.post('/reset-password', credentialLimiter, c.resetPassword);
router.get('/me', authenticateSupplier, c.me);

module.exports = router;

const router = require('express').Router();
const { login, me, changePassword } = require('../controllers/auth.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { credentialLimiter } = require('../middlewares/rateLimit.middleware');

// Throttle password guessing — a correct login doesn't count toward the limit,
// so a real admin who mistypes is never affected.
router.post('/login', credentialLimiter, login);
router.get('/me', authenticate, me);
router.post('/change-password', authenticate, changePassword);

module.exports = router;

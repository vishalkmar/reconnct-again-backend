const router = require('express').Router();
const {
  login, verifyLogin2fa, resendLoginEmailOtp, me, changePassword,
} = require('../controllers/auth.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { credentialLimiter } = require('../middlewares/rateLimit.middleware');

// Throttle password guessing — a correct login doesn't count toward the limit,
// so a real admin who mistypes is never affected.
router.post('/login', credentialLimiter, login);
// Second factor step (after password) — same throttle on wrong codes.
router.post('/login/2fa', credentialLimiter, verifyLogin2fa);
router.post('/login/2fa/resend-email', resendLoginEmailOtp);
router.get('/me', authenticate, me);
router.post('/change-password', authenticate, changePassword);

module.exports = router;

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/userAuth.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// Tight limiter on OTP issuance so the inbox can't be flooded.
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Please wait a minute and try again.' },
});

router.post('/request-otp', otpLimiter, ctrl.requestOtp);
router.post('/resend-otp', otpLimiter, ctrl.resendOtp);
router.post('/verify-otp', ctrl.verifyOtp);

router.post('/complete-profile', authenticateUser, ctrl.completeProfile);
router.get('/me', authenticateUser, ctrl.me);
router.patch('/profile', authenticateUser, ctrl.updateProfile);

module.exports = router;

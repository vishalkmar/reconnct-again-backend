const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/userAuth.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');
const { credentialLimiter } = require('../middlewares/rateLimit.middleware');

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
// The 6-digit OTP is only ~1M wide, so cap wrong guesses per (IP + email) —
// complements the 5-attempt cap already enforced per OTP token in the service.
router.post('/verify-otp', credentialLimiter, ctrl.verifyOtp);

// Account deletion REQUESTS — the in-app/portal path plus the public web page
// Play requires. Neither deletes; an admin actions the request.
router.post('/account/delete-request-me', authenticateUser, ctrl.requestMyDeletion);
router.post('/account/delete-request', otpLimiter, ctrl.requestAccountDeletion);

router.post('/complete-profile', authenticateUser, ctrl.completeProfile);
router.get('/me', authenticateUser, ctrl.me);
router.patch('/profile', authenticateUser, ctrl.updateProfile);

module.exports = router;

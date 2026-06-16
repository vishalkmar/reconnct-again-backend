const router = require('express').Router();
const ctrl = require('../controllers/auth.controller');
const { authenticatePwa } = require('../middlewares/pwaAuth.middleware');

// Unified login — identify how an email should authenticate (password vs OTP)
router.post('/identify', ctrl.identify);

// Auditor / Officer
router.post('/login', ctrl.login);
router.post('/verify-otp', ctrl.verifyLoginOtp);
router.post('/resend-otp', ctrl.resendOtp);

// Owner (passwordless) — legacy propertyCode + email flow
router.post('/owner/request-otp', ctrl.ownerRequestOtp);
router.post('/owner/verify-otp', ctrl.ownerVerifyOtp);

// Owner (passwordless) — email-only flow used by self-onboarding owners.
router.post('/owner/email/request-otp', ctrl.ownerEmailRequestOtp);
router.post('/owner/email/verify-otp', ctrl.ownerEmailVerifyOtp);

// Session
router.get('/me', authenticatePwa, ctrl.me);
router.post('/change-password', authenticatePwa, ctrl.changePassword);

module.exports = router;

const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/security.controller');

// Admin → Security. Admin-only (authenticate = admin token). Read + the two
// admin actions (change case status, unfreeze an account).
router.get('/fraud', authenticate, c.listFraud);
router.get('/fraud/:id', authenticate, c.getFraud);
router.patch('/fraud/:id/status', authenticate, c.updateFraudStatus);

router.get('/frozen', authenticate, c.listFrozen);
router.post('/frozen/:id/unfreeze', authenticate, c.unfreeze);
router.post('/unfreeze-email', authenticate, c.unfreezeByEmail);

// Test tooling — verify the whole pipeline on a live server without Burp.
// The simulate endpoint itself re-checks FRAUD_TEST_ENABLED.
router.get('/config', authenticate, c.config);
router.post('/simulate', authenticate, c.simulate);

// ── Two-Factor / MFA setup (the signed-in admin configures their own) ───────
router.get('/2fa/status', authenticate, c.twoFaStatus);
router.post('/2fa/email/enable', authenticate, c.enableEmail2fa);
router.post('/2fa/email/confirm', authenticate, c.confirmEmail2fa);
router.post('/2fa/email/disable', authenticate, c.disableEmail2fa);
router.post('/2fa/totp/setup', authenticate, c.setupTotp);
router.post('/2fa/totp/confirm', authenticate, c.confirmTotp);
router.post('/2fa/totp/disable', authenticate, c.disableTotp);

module.exports = router;

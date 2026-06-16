const router = require('express').Router();
const referral = require('../controllers/adminReferralConfig.controller');
const refund   = require('../controllers/adminRefundPolicy.controller');
const { authenticate } = require('../middlewares/auth.middleware');

router.use(authenticate);

// Referral system
router.get('/referral-config', referral.get);
router.put('/referral-config', referral.update);
router.post('/referral-config/reset', referral.reset);

// Refund policy
router.get('/refund-policy', refund.get);
router.put('/refund-policy', refund.update);
router.post('/refund-policy/reset', refund.reset);
router.post('/refund-policy/reconcile/:bookingCode', refund.reconcile);

module.exports = router;

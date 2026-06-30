const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/payment.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// Webhook stays public (Cashfree calls it server-to-server) and skips the
// global JSON parser — we feed it the raw body via express.raw() so the HMAC
// matches what Cashfree signed. Verifying the signature in the handler is
// what actually authenticates this endpoint.
router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), ctrl.webhook);

router.post('/orders/:code', authenticateUser, ctrl.createOrderForBooking);
router.get('/verify/:code', authenticateUser, ctrl.verifyBookingPayment);

// Mobile hosted-link flow: create a payment link for a booking + poll status.
router.post('/links/:code', authenticateUser, ctrl.createLinkForBooking);
router.get('/link-status/:code', authenticateUser, ctrl.bookingLinkStatus);

module.exports = router;

const router = require('express').Router();
const ctrl = require('../controllers/booking.controller');
const reviewCtrl = require('../controllers/experienceReview.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// All booking operations require a signed-in user. Admin-side listing lives
// under /admin/bookings (added in Phase 8).
router.use(authenticateUser);

router.post('/preview', ctrl.preview);
router.post('/', ctrl.create);
router.get('/me', ctrl.listMine);
// Ahead of /me/:code so "pending-review" isn't swallowed as a booking code.
router.get('/me/pending-review', reviewCtrl.pendingReview);
router.get('/me/:code', ctrl.getMineByCode);
router.get('/me/:code/voucher.pdf', ctrl.voucherPdf);
router.get('/me/:code/cancel-quote', ctrl.cancelQuote);
router.post('/me/:code/cancel', ctrl.cancelMine);
router.post('/:bookingCode/review', reviewCtrl.submitForBooking);
router.post('/:bookingCode/review/dismiss', reviewCtrl.dismissPrompt);

module.exports = router;

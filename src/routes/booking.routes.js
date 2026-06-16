const router = require('express').Router();
const ctrl = require('../controllers/booking.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// All booking operations require a signed-in user. Admin-side listing lives
// under /admin/bookings (added in Phase 8).
router.use(authenticateUser);

router.post('/preview', ctrl.preview);
router.post('/', ctrl.create);
router.get('/me', ctrl.listMine);
router.get('/me/:code', ctrl.getMineByCode);
router.get('/me/:code/cancel-quote', ctrl.cancelQuote);
router.post('/me/:code/cancel', ctrl.cancelMine);

module.exports = router;

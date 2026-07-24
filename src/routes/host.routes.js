const router = require('express').Router();
const ctrl = require('../controllers/host.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// Every host endpoint is scoped to the signed-in user (the host).
router.use(authenticateUser);

router.get('/summary', ctrl.summary);
router.get('/listings', ctrl.listMine);
router.get('/listings/:id', ctrl.getMine);
router.get('/all-bookings', ctrl.allBookings);
router.get('/account-manager', require('../controllers/supplierPortal.controller').hostAccountManager);
router.get('/bookings/:id', ctrl.getBooking);
router.get('/transactions', ctrl.listTransactions);
router.post('/listings', ctrl.createMine);
router.put('/listings/:id', ctrl.updateMine);
// Owner's written acknowledgement of post-QC changes (Under Progress) — same
// handshake the supplier portal has.
router.post('/listings/:id/up-ack', ctrl.upAckMine);
router.delete('/listings/:id', ctrl.removeMine);

module.exports = router;

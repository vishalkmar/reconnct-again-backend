const router = require('express').Router();
const ctrl = require('../controllers/host.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// Every host endpoint is scoped to the signed-in user (the host).
router.use(authenticateUser);

router.get('/summary', ctrl.summary);
router.get('/listings', ctrl.listMine);
router.get('/listings/:id', ctrl.getMine);
router.get('/all-bookings', ctrl.allBookings);
router.get('/bookings/:id', ctrl.getBooking);
router.get('/transactions', ctrl.listTransactions);
router.post('/listings', ctrl.createMine);
router.put('/listings/:id', ctrl.updateMine);
router.delete('/listings/:id', ctrl.removeMine);

module.exports = router;

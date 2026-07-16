const router = require('express').Router();
const ctrl = require('../controllers/host.controller');
const notificationCtrl = require('../controllers/notification.controller');
const { authenticateSupplier } = require('../middlewares/supplierAuth.middleware');

// A supplier's own dashboard — a straight clone of the Host system, same
// controller functions (host.controller.js resolves ownership from
// req.supplier here vs req.user on /api/host/*). Mounted at /api/supplier.
router.use(authenticateSupplier);

router.get('/summary', ctrl.summary);
router.get('/listings', ctrl.listMine);
router.get('/listings/:id', ctrl.getMine);
router.get('/bookings/:id', ctrl.getBooking);
router.get('/transactions', ctrl.listTransactions);
router.post('/listings', ctrl.createMine);
router.put('/listings/:id', ctrl.updateMine);
router.delete('/listings/:id', ctrl.removeMine);
router.get('/notifications', notificationCtrl.listForSupplier);

module.exports = router;

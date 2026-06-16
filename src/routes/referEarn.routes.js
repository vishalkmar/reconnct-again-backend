const router = require('express').Router();
const ctrl = require('../controllers/referEarn.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// All endpoints are user-scoped — wallet history and coupons are personal.
router.use(authenticateUser);

router.get('/wallet', ctrl.getWallet);
router.get('/coupons', ctrl.listCoupons);
router.get('/referees', ctrl.listReferees);
router.get('/config', ctrl.getConfig);
router.post('/validate-coupon', ctrl.validateCoupon);

module.exports = router;

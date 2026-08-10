const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const {
  listLive, detail, tally, supplierRevenue, supplierRevenueDetail,
} = require('../controllers/b2bManagement.controller');

// Admin B2B Management — command centre over every live experience + payment tally.
router.get('/experiences', authenticate, listLive);
router.get('/experiences/:id', authenticate, detail);
router.get('/tally', authenticate, tally);
// Per-supplier B2B vs B2C revenue (rollup + one-supplier split view).
router.get('/supplier-revenue', authenticate, supplierRevenue);
router.get('/supplier-revenue/:id', authenticate, supplierRevenueDetail);

module.exports = router;

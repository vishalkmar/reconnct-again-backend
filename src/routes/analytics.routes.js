const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { revenue, revenueAnalysis } = require('../controllers/analytics.controller');

router.get('/revenue', authenticate, revenue);
router.get('/revenue-analysis', authenticate, revenueAnalysis);

module.exports = router;

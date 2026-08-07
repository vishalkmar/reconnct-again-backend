const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { dashboard } = require('../controllers/adminDashboard.controller');

// Admin home command-center aggregate.
router.get('/', authenticate, dashboard);

module.exports = router;

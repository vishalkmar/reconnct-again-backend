const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { revenue } = require('../controllers/analytics.controller');

router.get('/revenue', authenticate, revenue);

module.exports = router;

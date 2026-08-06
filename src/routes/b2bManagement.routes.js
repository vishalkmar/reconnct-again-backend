const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { listLive, detail, tally } = require('../controllers/b2bManagement.controller');

// Admin B2B Management — command centre over every live experience + payment tally.
router.get('/experiences', authenticate, listLive);
router.get('/experiences/:id', authenticate, detail);
router.get('/tally', authenticate, tally);

module.exports = router;

const router = require('express').Router();
const ctrl = require('../controllers/notification.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// Notifications are per-user (derived from their bookings + wallet activity).
router.use(authenticateUser);
router.get('/', ctrl.list);

module.exports = router;

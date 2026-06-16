const router = require('express').Router();
const ctrl = require('../controllers/adminBooking.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// Admin-only — uses the existing admin JWT (Authorization header), not the
// user X-User-Auth header.
router.use(authenticate);

router.get('/', ctrl.list);
router.get('/:code', ctrl.getByCode);
router.post('/:code/mark-completed', ctrl.markCompleted);

module.exports = router;

const router = require('express').Router();
const ctrl = require('../controllers/adminNotification.controller');
const { authenticate } = require('../middlewares/auth.middleware');

router.use(authenticate);

router.get('/', ctrl.list);

module.exports = router;

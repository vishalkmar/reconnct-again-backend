const router = require('express').Router();
const ctrl = require('../controllers/sectionTheme.controller');
const { authenticate } = require('../middlewares/auth.middleware');

router.get('/', ctrl.get);
router.put('/', authenticate, ctrl.update);

module.exports = router;

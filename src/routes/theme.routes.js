const router = require('express').Router();
const ctrl = require('../controllers/theme.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// Public
router.get('/', ctrl.getTheme);
router.get('/presets', ctrl.getPresets);

// Admin
router.put('/', authenticate, ctrl.updateTheme);
router.post('/reset', authenticate, ctrl.resetTheme);

module.exports = router;

const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/appScreen.controller');

// Admin-only "App Screens Control". Public reads happen via /api/public/app-screen/:key.
// Offer banners (specific routes BEFORE the catch-all /:key).
router.get('/offer-banners', authenticate, c.adminGetBanners);
router.put('/offer-banners', authenticate, c.updateBanners);

router.get('/:key', authenticate, c.getScreen);
router.put('/:key', authenticate, c.updateScreen);

module.exports = router;

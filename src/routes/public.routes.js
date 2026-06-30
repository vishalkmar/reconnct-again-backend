const router = require('express').Router();
const c = require('../controllers/public.controller');
const appScreen = require('../controllers/appScreen.controller');
const geo = require('../controllers/geo.controller');

/*
  PUBLIC app surface — no auth. Read-only, published experiences only.
  Mounted at /api/public. Auth (OTP) for the app reuses /api/user-auth/*.
*/
router.get('/taxonomy', c.taxonomy);
router.get('/types', c.types);
router.get('/cities', c.cities);

// Mobile payments — create a Cashfree hosted link server-side.
router.post('/payments/cashfree-link', c.cashfreeLink);
router.get('/experiences', c.listExperiences);
router.get('/experiences/:idOrSlug', c.getExperience);

// App Screens Control (login/OTP content + media)
router.get('/app-screen/:key', appScreen.getScreen);
router.get('/offer-banners', appScreen.getBanners);

// Location intelligence — detect city by IP, nearby suggestions via LLM.
router.get('/geo/locate', geo.locate);
router.get('/geo/nearby', geo.nearby);

module.exports = router;

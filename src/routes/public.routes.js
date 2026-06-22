const router = require('express').Router();
const c = require('../controllers/public.controller');

/*
  PUBLIC app surface — no auth. Read-only, published experiences only.
  Mounted at /api/public. Auth (OTP) for the app reuses /api/user-auth/*.
*/
router.get('/taxonomy', c.taxonomy);
router.get('/experiences', c.listExperiences);
router.get('/experiences/:idOrSlug', c.getExperience);

module.exports = router;

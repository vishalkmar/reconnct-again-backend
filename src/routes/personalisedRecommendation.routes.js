const router = require('express').Router();
const ctrl = require('../controllers/personalisedRecommendation.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('personalised-recommendation');

router.get('/', ctrl.get);
router.put(
  '/',
  authenticate,
  upload.fields([{ name: 'centerImage', maxCount: 1 }]),
  ctrl.update,
);

module.exports = router;

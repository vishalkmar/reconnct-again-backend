const router = require('express').Router();
const ctrl = require('../controllers/siteInfo.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('site-info');
const logoUpload = upload.fields([{ name: 'logo', maxCount: 1 }]);

router.get('/', ctrl.get);
router.put('/', authenticate, logoUpload, ctrl.update);

module.exports = router;

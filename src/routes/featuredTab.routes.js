const router = require('express').Router();
const ctrl = require('../controllers/featuredTab.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');

const upload = buildUploader('featured-tabs');
const tabUpload = upload.fields([{ name: 'image', maxCount: 1 }]);

router.get('/', ctrl.list);
router.put('/:tabKey', authenticate, tabUpload, ctrl.updateTab);

module.exports = router;

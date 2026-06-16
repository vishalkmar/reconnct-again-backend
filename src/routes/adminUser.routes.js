const router = require('express').Router();
const ctrl = require('../controllers/adminUser.controller');
const { authenticate } = require('../middlewares/auth.middleware');

router.use(authenticate);

router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.get('/:id/voucher/:bookingCode', ctrl.getVoucherHtml);
router.post('/:id/send-email', ctrl.sendEmail);
router.post('/:id/toggle-active', ctrl.toggleActive);

module.exports = router;

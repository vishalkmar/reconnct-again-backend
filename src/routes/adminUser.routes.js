const router = require('express').Router();
const ctrl = require('../controllers/adminUser.controller');
const { authenticate } = require('../middlewares/auth.middleware');

router.use(authenticate);

router.get('/', ctrl.list);

// Account deletion queue. MUST sit above '/:id' — Express matches in order and
// '/:id' would otherwise swallow 'deletion-requests' as a user id.
router.get('/deletion-requests', ctrl.listDeletionRequests);
router.post('/deletion-requests/:id/approve', ctrl.approveDeletionRequest);
router.post('/deletion-requests/:id/reject', ctrl.rejectDeletionRequest);

router.get('/:id', ctrl.getById);
router.get('/:id/voucher/:bookingCode', ctrl.getVoucherHtml);
router.post('/:id/send-email', ctrl.sendEmail);
router.post('/:id/toggle-active', ctrl.toggleActive);

module.exports = router;

const router = require('express').Router();
const ctrl = require('../controllers/notification.controller');
const { authenticatePwa } = require('../middlewares/pwaAuth.middleware');

// Any authenticated PWA user can read/clear their own notifications.
router.use(authenticatePwa);

router.get('/', ctrl.list);
router.get('/unread-count', ctrl.unreadCount);
router.post('/read-all', ctrl.markAllRead);
router.post('/:id/read', ctrl.markRead);

module.exports = router;

const router = require('express').Router();
const { authenticateStaff, requireStaffPermission } = require('../middlewares/staffAuth.middleware');
const c = require('../controllers/reviewQueue.controller');

// Center Ops (COPS) review queue — admin OR a team member with
// canReviewListings. Mounted at /api/team/review-queue.
router.use(authenticateStaff, requireStaffPermission('canReviewListings'));

router.get('/', c.list);
router.get('/qcops-options', c.qcopsOptions);
router.post('/:id/approve', c.approve);
router.post('/:id/reject', c.reject);
router.post('/:id/request-changes', c.requestChanges);
router.post('/:id/assign-qcops', c.assignQcops);

module.exports = router;

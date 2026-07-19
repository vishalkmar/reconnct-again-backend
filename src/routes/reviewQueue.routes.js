const router = require('express').Router();
const { authenticateStaff, requireStaffPermission } = require('../middlewares/staffAuth.middleware');
const c = require('../controllers/reviewQueue.controller');

// Center Ops (COPS) review queue — admin OR a team member with
// canReviewListings. Mounted at /api/team/review-queue.
router.use(authenticateStaff, requireStaffPermission('canReviewListings'));

router.get('/', c.list);
router.get('/board', c.board);
router.get('/qcops-options', c.qcopsOptions);
router.get('/:id', c.getOne);

// Granular section-by-section review
router.post('/:id/section', c.decideSection);
router.put('/:id/suggestion', c.saveSuggestion);
router.post('/:id/final-approve', c.finalApprove);
router.post('/:id/direct-list', c.directList);
router.post('/:id/follow-up', c.followUp);
router.post('/:id/reject', c.reject);
router.post('/:id/send-qcops', c.sendQcops);

// Legacy whole-item actions (kept for backward compatibility)
router.post('/:id/request-changes', c.requestChanges);
router.post('/:id/assign-qcops', c.assignQcops);

module.exports = router;

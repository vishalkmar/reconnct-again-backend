const router = require('express').Router();
const { authenticateTeamMember, requirePermission } = require('../middlewares/teamAuth.middleware');
const c = require('../controllers/reviewStats.controller');

router.use(authenticateTeamMember);

// Submitter's own board (BD etc.).
router.get('/mine', c.mine);
// Center Ops / QCOPS queue-wide board.
router.get('/queue', requirePermission('canReviewListings'), c.queue);

module.exports = router;

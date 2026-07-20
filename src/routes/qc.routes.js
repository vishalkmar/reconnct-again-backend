const router = require('express').Router();
const { authenticateTeamMember, requirePermission } = require('../middlewares/teamAuth.middleware');
const c = require('../controllers/qc.controller');

router.use(authenticateTeamMember);

// COPS-only guard: can review AND is not themselves a QCOPS (a QCOPS must not
// approve/reject their own on-site feedback).
const requireCops = (req, res, next) => {
  const perms = (req.teamMember && req.teamMember.permissions) || {};
  if (!perms.canReviewListings || req.teamMember.roleType === 'qcops') {
    return res.status(403).json({ success: false, message: 'Center Ops access required' });
  }
  next();
};

// ── QCOPS's own assignments ──
router.get('/mine', c.mine);
router.get('/feedback-schema', c.feedbackSchema);
router.post('/:id/ack', c.ack);
router.post('/:id/onsite', c.onsite);
router.post('/:id/feedback', c.submitFeedback);

// ── Center Ops decision + QCOPS management ──
router.post('/:id/go-live', requireCops, c.goLive);
router.post('/:id/up-ack', requireCops, c.upAck);
router.post('/:id/up-reject', requireCops, c.upReject);
router.post('/:id/delist', requireCops, c.delist);
router.get('/management', requirePermission('canReviewListings'), c.management);
router.get('/management/:qcopsId', requirePermission('canReviewListings'), c.managementDetail);

module.exports = router;

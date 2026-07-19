const router = require('express').Router();
const { authenticateTeamMember, requirePermission } = require('../middlewares/teamAuth.middleware');
const c = require('../controllers/reviewStats.controller');

router.use(authenticateTeamMember);

// Submitter's own board (BD etc.).
router.get('/mine', c.mine);
router.get('/my-experiences', c.myExperiences);
router.get('/my-suppliers', c.mySuppliers);
router.get('/my-suppliers/:supplierId/experiences', c.mySupplierExperiences);
// Center Ops / QCOPS queue-wide board.
router.get('/queue', requirePermission('canReviewListings'), c.queue);

module.exports = router;

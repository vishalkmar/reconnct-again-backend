const router = require('express').Router();
const { authenticateTeamMember } = require('../middlewares/teamAuth.middleware');
const c = require('../controllers/categoryManagerDash.controller');

// Mounted at /api/team/category — the Category Manager dashboard. Every route
// is scoped to the categories the signed-in CM owns (see the controller).
router.use(authenticateTeamMember);
router.get('/summary', c.summary);
router.get('/suppliers', c.suppliers);
router.get('/status', c.status);
router.get('/status/:id', c.statusDetail);
router.get('/reviews', c.reviews);
router.get('/revenue', c.revenue);
router.get('/onboardings', c.onboardings);
router.get('/delisted', c.delisted);
router.get('/churn', c.churn);

module.exports = router;

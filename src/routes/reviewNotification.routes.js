const router = require('express').Router();
const { authenticateTeamMember } = require('../middlewares/teamAuth.middleware');
const c = require('../controllers/reviewNotification.controller');

// Every team member (BD / COPS / QCOPS / …) has their own review bell.
router.use(authenticateTeamMember);

router.get('/', c.list);
router.post('/read-all', c.readAll);
router.post('/:id/read', c.readOne);

module.exports = router;

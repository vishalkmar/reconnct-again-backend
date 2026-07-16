const router = require('express').Router();
const { authenticateTeamMember } = require('../middlewares/teamAuth.middleware');
const c = require('../controllers/teamAuth.controller');

// Mounted at /api/team/auth — internal staff (BD/COPS/AM/CSM/QCOPS/
// Marketing) sign-in, separate from admin and user auth.
router.post('/login', c.login);
router.get('/me', authenticateTeamMember, c.me);

module.exports = router;

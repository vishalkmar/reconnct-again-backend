const router = require('express').Router();
const { authenticateTeamMember } = require('../middlewares/teamAuth.middleware');
const { credentialLimiter, requestLinkLimiter } = require('../middlewares/rateLimit.middleware');
const c = require('../controllers/teamAuth.controller');

// Mounted at /api/team/auth — internal staff (BD/COPS/AM/CSM/QCOPS/
// Marketing) sign-in, separate from admin and user auth.
router.post('/login', credentialLimiter, c.login);
router.post('/forgot-password', requestLinkLimiter, c.forgotPassword);
router.post('/reset-password', credentialLimiter, c.resetPassword);
router.post('/select-role', authenticateTeamMember, c.selectRole);
router.get('/me', authenticateTeamMember, c.me);

module.exports = router;

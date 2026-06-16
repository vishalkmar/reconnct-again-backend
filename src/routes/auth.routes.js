const router = require('express').Router();
const { login, me, changePassword } = require('../controllers/auth.controller');
const { authenticate } = require('../middlewares/auth.middleware');

router.post('/login', login);
router.get('/me', authenticate, me);
router.post('/change-password', authenticate, changePassword);

module.exports = router;

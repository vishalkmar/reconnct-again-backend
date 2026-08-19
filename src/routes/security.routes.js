const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/security.controller');

// Admin → Security. Admin-only (authenticate = admin token). Read + the two
// admin actions (change case status, unfreeze an account).
router.get('/fraud', authenticate, c.listFraud);
router.get('/fraud/:id', authenticate, c.getFraud);
router.patch('/fraud/:id/status', authenticate, c.updateFraudStatus);

router.get('/frozen', authenticate, c.listFrozen);
router.post('/frozen/:id/unfreeze', authenticate, c.unfreeze);
router.post('/unfreeze-email', authenticate, c.unfreezeByEmail);

module.exports = router;

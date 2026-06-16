const router = require('express').Router();

// All PWA endpoints live behind /api/pwa to keep them visibly separate from
// the existing website API. Sub-routers are mounted lazily so a startup
// error in a single sub-router doesn't kill the whole API.

router.use('/auth', require('./auth.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/auditor', require('./auditor.routes'));
router.use('/officer', require('./officer.routes'));
router.use('/owner', require('./owner.routes'));
router.use('/notifications', require('./notification.routes'));

router.get('/health', (req, res) =>
  res.json({ success: true, message: 'PWA API healthy', ts: new Date().toISOString() })
);

module.exports = router;

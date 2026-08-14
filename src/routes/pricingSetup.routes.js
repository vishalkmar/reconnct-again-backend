const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateStaff } = require('../middlewares/staffAuth.middleware');
const m = require('../controllers/markupRule.controller');
const { markupAnalytics } = require('../controllers/markupAnalytics.controller');

/*
  Admin "Pricing Setup Management". Markup Management is the first module;
  Discount / GST & Taxes / Convenience will mount alongside it here.

  Managing the rules is ADMIN-only. Reading the resolved markup — and setting
  the per-experience override from the go-live pricing screen — also has to work
  for Center Ops in the Team Portal, so those use authenticateStaff (admin still
  passes it unchanged).
*/

// ── Markup Management ──────────────────────────────────────────────────────
router.get('/markup/rules', authenticate, m.listRules);
router.post('/markup/rules', authenticate, m.createRule);
router.put('/markup/rules/:id', authenticate, m.updateRule);
router.patch('/markup/rules/:id/toggle', authenticate, m.toggleRule);
router.delete('/markup/rules/:id', authenticate, m.removeRule);

router.get('/markup/targets', authenticate, m.targets);
router.get('/markup/effective', authenticate, m.effectiveList);
router.post('/markup/resync', authenticate, m.resync);

router.get('/markup/analytics', authenticate, markupAnalytics);

// Shared with the Team Portal's go-live pricing modal.
router.get('/markup/experience/:experienceId', authenticateStaff, m.effectiveForExperience);
router.put('/markup/experience/:experienceId', authenticateStaff, m.setExperienceOverride);
router.delete('/markup/experience/:experienceId', authenticateStaff, m.clearExperienceOverride);

module.exports = router;

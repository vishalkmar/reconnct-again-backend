const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateStaff } = require('../middlewares/staffAuth.middleware');
const m = require('../controllers/markupRule.controller');
const { markupAnalytics } = require('../controllers/markupAnalytics.controller');
const g = require('../controllers/gstRule.controller');
const { gstAnalytics } = require('../controllers/gstAnalytics.controller');
const c = require('../controllers/convenienceRule.controller');
const { convenienceAnalytics } = require('../controllers/convenienceAnalytics.controller');
const d = require('../controllers/discountCoupon.controller');

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

// ── GST & Taxes Management ─────────────────────────────────────────────────
router.get('/gst/rules', authenticate, g.listRules);
router.post('/gst/rules', authenticate, g.createRule);
router.put('/gst/rules/:id', authenticate, g.updateRule);
router.patch('/gst/rules/:id/toggle', authenticate, g.toggleRule);
router.delete('/gst/rules/:id', authenticate, g.removeRule);

router.get('/gst/targets', authenticate, g.targets);
router.get('/gst/effective', authenticate, g.effectiveList);
router.post('/gst/resync', authenticate, g.resync);

router.get('/gst/analytics', authenticate, gstAnalytics);

// Shared with the Team Portal's go-live pricing modal (the included/double/pure
// decision is Center Ops's to make, not only the admin's).
router.get('/gst/experience/:experienceId', authenticateStaff, g.effectiveForExperience);
router.put('/gst/experience/:experienceId', authenticateStaff, g.setExperienceDecision);
router.delete('/gst/experience/:experienceId', authenticateStaff, g.clearExperienceDecision);

// ── Convenience Management ─────────────────────────────────────────────────
router.get('/convenience/rules', authenticate, c.listRules);
router.post('/convenience/rules', authenticate, c.createRule);
router.put('/convenience/rules/:id', authenticate, c.updateRule);
router.patch('/convenience/rules/:id/toggle', authenticate, c.toggleRule);
router.delete('/convenience/rules/:id', authenticate, c.removeRule);

router.get('/convenience/targets', authenticate, c.targets);
router.get('/convenience/effective', authenticate, c.effectiveList);
router.post('/convenience/resync', authenticate, c.resync);

router.get('/convenience/analytics', authenticate, convenienceAnalytics);

// Shared with the Team Portal's go-live pricing modal.
router.get('/convenience/experience/:experienceId', authenticateStaff, c.effectiveForExperience);
router.put('/convenience/experience/:experienceId', authenticateStaff, c.setExperienceOverride);
router.delete('/convenience/experience/:experienceId', authenticateStaff, c.clearExperienceOverride);

// ── Discount Management (coupon-based) ─────────────────────────────────────
// A discount is only real once it has a code a customer can type, so the code
// is generated first and the coupon is created with it in one go.
router.get('/discount/coupons', authenticate, d.listCoupons);
router.post('/discount/generate-code', authenticate, d.generateCode);
router.post('/discount/coupons', authenticate, d.createCoupon);
router.put('/discount/coupons/:id', authenticate, d.updateCoupon);
router.patch('/discount/coupons/:id/toggle', authenticate, d.toggleCoupon);
router.delete('/discount/coupons/:id', authenticate, d.removeCoupon);

router.get('/discount/targets', authenticate, d.targets);
router.get('/discount/analytics', authenticate, d.discountAnalytics);

module.exports = router;

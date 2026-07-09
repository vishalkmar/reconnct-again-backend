const router = require('express').Router();
const ctrl = require('../controllers/experienceReview.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// Every route here is admin-only — mounted at /api/admin/experience-reviews.
router.use(authenticate);

router.get('/filter-options', ctrl.filterOptions);
router.get('/analytics', ctrl.analytics);
router.get('/', ctrl.listAdminExperienceReviews);
router.delete('/:id', ctrl.removeExperienceReview);

module.exports = router;

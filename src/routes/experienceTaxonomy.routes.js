const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateStaff, requireStaffPermission } = require('../middlewares/staffAuth.middleware');
const c = require('../controllers/experienceTaxonomy.controller');

// Taxonomy MANAGEMENT (create/edit/toggle/delete the categories/types/
// audiences themselves) is admin-only. Reading the lists is also open to a
// team member with canAddExperience — they need these to fill out the
// experience form's taxonomy picker, same as the admin form does.

// Audiences
router.get('/audiences', authenticateStaff, requireStaffPermission('canAddExperience'), c.listAudiences);
router.post('/audiences', authenticate, c.createAudience);
router.put('/audiences/:id', authenticate, c.updateAudience);
router.patch('/audiences/:id/toggle', authenticate, c.toggleAudience);
router.delete('/audiences/:id', authenticate, c.removeAudience);

// Broad categories
router.get('/categories', authenticateStaff, requireStaffPermission('canAddExperience'), c.listCategories);
router.post('/categories', authenticate, c.createCategory);
router.put('/categories/:id', authenticate, c.updateCategory);
router.patch('/categories/:id/toggle', authenticate, c.toggleCategory);
router.delete('/categories/:id', authenticate, c.removeCategory);

// Types (under a category)
router.get('/types', authenticateStaff, requireStaffPermission('canAddExperience'), c.listTypes);
router.post('/types', authenticate, c.createType);
router.put('/types/:id', authenticate, c.updateType);
router.patch('/types/:id/toggle', authenticate, c.toggleType);
router.delete('/types/:id', authenticate, c.removeType);

module.exports = router;

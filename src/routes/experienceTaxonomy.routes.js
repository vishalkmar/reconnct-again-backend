const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/experienceTaxonomy.controller');

// All taxonomy management is admin-only. The admin form reads + inline-creates
// through these same endpoints (no separate "public" surface needed yet).

// Audiences
router.get('/audiences', authenticate, c.listAudiences);
router.post('/audiences', authenticate, c.createAudience);
router.put('/audiences/:id', authenticate, c.updateAudience);
router.patch('/audiences/:id/toggle', authenticate, c.toggleAudience);
router.delete('/audiences/:id', authenticate, c.removeAudience);

// Broad categories
router.get('/categories', authenticate, c.listCategories);
router.post('/categories', authenticate, c.createCategory);
router.put('/categories/:id', authenticate, c.updateCategory);
router.patch('/categories/:id/toggle', authenticate, c.toggleCategory);
router.delete('/categories/:id', authenticate, c.removeCategory);

// Types (under a category)
router.get('/types', authenticate, c.listTypes);
router.post('/types', authenticate, c.createType);
router.put('/types/:id', authenticate, c.updateType);
router.patch('/types/:id/toggle', authenticate, c.toggleType);
router.delete('/types/:id', authenticate, c.removeType);

module.exports = router;

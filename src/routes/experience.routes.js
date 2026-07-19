const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateStaff, requireStaffPermission } = require('../middlewares/staffAuth.middleware');
const c = require('../controllers/experience.controller');

// List/view/create — admin OR a team member (BD) with canAddExperience.
router.get('/', authenticateStaff, c.list);
router.put('/reorder', authenticate, c.reorder); // before /:id so it isn't swallowed
router.get('/:id', authenticateStaff, c.getOne);
router.post('/', authenticateStaff, requireStaffPermission('canAddExperience'), c.create);

// Edit — admin, OR the team member who created it while it's still editable
// (draft, e.g. after Center Ops requested changes — checked inside the
// controller). Duplicate/toggle/delete/reorder stay fully admin-only.
router.put('/:id', authenticateStaff, c.update);
router.post('/:id/resubmit', authenticateStaff, c.resubmit);
router.post('/:id/up-respond', authenticateStaff, c.upRespond);
router.post('/:id/duplicate', authenticate, c.duplicate);
router.patch('/:id/toggle', authenticate, c.toggle);
router.delete('/:id', authenticate, c.remove);

module.exports = router;

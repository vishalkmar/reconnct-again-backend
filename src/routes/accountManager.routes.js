const router = require('express').Router();
const { authenticateStaff, requireStaffPermission } = require('../middlewares/staffAuth.middleware');
const c = require('../controllers/accountManager.controller');

// Mounted at /api/team/my-suppliers — admin OR a team member with
// canManageAccounts (the Account Manager role's default).
router.get('/', authenticateStaff, requireStaffPermission('canManageAccounts'), c.mySuppliers);
router.get('/overview', authenticateStaff, requireStaffPermission('canManageAccounts'), c.overview);
router.get('/:supplierId/experiences', authenticateStaff, requireStaffPermission('canManageAccounts'), c.supplierExperiences);

module.exports = router;

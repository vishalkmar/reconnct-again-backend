const router = require('express').Router();
const { authenticateStaff, requireStaffPermission } = require('../middlewares/staffAuth.middleware');
const c = require('../controllers/csm.controller');

// Mounted at /api/team/my-customers — admin OR a team member with
// canManageCustomers (the CSM role's default).
router.get('/', authenticateStaff, requireStaffPermission('canManageCustomers'), c.myCustomers);

module.exports = router;

const router = require('express').Router();
const ctrl = require('../controllers/salesperson.controller');
const { authenticatePwa, requireRoles } = require('../middlewares/pwaAuth.middleware');

router.use(authenticatePwa, requireRoles('salesperson'));

router.get('/leads', ctrl.listMyLeads);
router.get('/leads/:leadId', ctrl.getLead);
router.post('/leads/:leadId/not-converted', ctrl.markNotConverted);
router.post('/leads/:leadId/converted', ctrl.markConverted);
router.post('/leads/:leadId/request-another-date', ctrl.requestAnotherDate);

module.exports = router;

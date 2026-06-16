const router = require('express').Router();
const ctrl = require('../controllers/officer.controller');
const propertyCtrl = require('../controllers/property.controller');
const phase4Ctrl = require('../controllers/phase4.controller');
const { authenticatePwa, requireRoles } = require('../middlewares/pwaAuth.middleware');
const { buildUploader } = require('../../middlewares/upload.middleware');

const contractUpload = buildUploader('pwa-contracts', {
  allowed: /pdf|application\/pdf/,
  message: 'Only PDF files are allowed',
});

router.use(authenticatePwa, requireRoles('officer'));

router.get('/properties', ctrl.listProperties);
router.get('/properties/:id', ctrl.getProperty);
router.post('/properties/:id/claim', ctrl.claim);
router.patch('/properties/:id/fields/:sectionKey/decision', ctrl.decideField);
router.put('/properties/:id/suggestion', ctrl.updateSuggestion);
router.post('/properties/:id/follow-up', ctrl.followUpProperty);
router.post('/properties/:id/approve', ctrl.approveProperty);
router.post('/properties/:id/reject', ctrl.rejectProperty);
router.post('/properties/:id/list-on-website', ctrl.listOnWebsite);

// Phase 4 review.
router.get('/phase4/:id', phase4Ctrl.getForOfficer);
router.post('/phase4/:id/sections/:sectionKey/decide', phase4Ctrl.decideSection);
router.post('/phase4/:id/send-back', phase4Ctrl.sendBackForRevision);
router.post('/phase4/:id/final-approve', phase4Ctrl.finalApprove);

// Contracts dashboard (sent / received / listed) and a PDF proxy.
router.get('/contracts', ctrl.listContracts);
router.get('/contracts/:id/pdf', ctrl.downloadContractPdf);
router.post('/contracts/:id/upload-initial', contractUpload.single('contract'), ctrl.uploadInitialContract);
router.post('/contracts/:id/upload-final', contractUpload.single('contract'), ctrl.uploadFinalContract);
router.post('/contracts/:id/complete', ctrl.completeSelfContract);

// Messages reuse the shared controller (handler checks officer access).
router.get('/properties/:id/messages', propertyCtrl.listMessages);
router.post('/properties/:id/messages', propertyCtrl.postMessage);

module.exports = router;

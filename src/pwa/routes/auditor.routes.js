const router = require('express').Router();
const ctrl = require('../controllers/property.controller');
const listingCtrl = require('../controllers/listingImage.controller');
const contractCtrl = require('../controllers/auditorContract.controller');
const phase4Ctrl = require('../controllers/phase4.controller');
const { authenticatePwa, requireRoles } = require('../middlewares/pwaAuth.middleware');
const { buildUploader } = require('../../middlewares/upload.middleware');

const upload = buildUploader('pwa-audits');
const sectionUpload = upload.array('photos', 50);
const contractUpload = buildUploader('pwa-contracts', {
  allowed: /pdf|application\/pdf/,
  message: 'Only PDF files are allowed',
});

const listingUpload = buildUploader('pwa-listing-images').array('photos', 30);

router.use(authenticatePwa, requireRoles('auditor'));

// Phase 1 / 2 / 3 lifecycle
router.post('/properties', ctrl.createPhase1);
router.post('/properties/:id/generate-id', ctrl.generateId);
router.put('/properties/:id/sections/:sectionKey', sectionUpload, ctrl.upsertSection);
router.post('/properties/:id/submit', ctrl.submitForReview);

// Single-photo helper for the per-room photo blocks inside the rooms
// section editor — each pick uploads eagerly so the rest of the form just
// references URLs.
router.post('/properties/:id/upload-one', upload.single('photo'), ctrl.uploadOnePhoto);

// Reads
router.get('/properties', ctrl.listMyProperties);
router.get('/properties/:id', ctrl.getMyProperty);

// Messaging
router.get('/properties/:id/messages', ctrl.listMessages);
router.post('/properties/:id/messages', ctrl.postMessage);

// Final listing images (post-approval). Section-tagged, no upload cap.
router.get('/listing-images/properties', listingCtrl.listEligibleProperties);
router.get('/listing-images/:propertyId', listingCtrl.listForProperty);
router.post('/listing-images/:propertyId', listingUpload, listingCtrl.uploadImages);
router.put('/listing-images/:propertyId/:imageId/caption', listingCtrl.updateCaption);
router.delete('/listing-images/:propertyId/:imageId', listingCtrl.removeImage);

// Contracts — post-approval, before owner email.
router.get('/contracts', contractCtrl.listForAuditor);
router.get('/contracts/:propertyId', contractCtrl.getOne);
router.get('/contracts/:propertyId/pdf', contractCtrl.downloadPdf);
router.post('/contracts/:propertyId/upload-contract', contractUpload.single('contract'), contractCtrl.uploadSignedByAuditor);
router.post('/contracts/:propertyId/upload-signed', contractUpload.single('contract'), contractCtrl.uploadSignedByAuditor);
router.post('/contracts/:propertyId/send-to-owner', contractCtrl.sendToOwner);

// Phase 4 — CRM-style deep-dive after Phase 3 approval.
router.get('/properties/:id/phase4', phase4Ctrl.getForAuditor);
router.put('/properties/:id/phase4/:sectionKey', phase4Ctrl.upsertSection);
router.post('/properties/:id/phase4/submit', phase4Ctrl.submitForReview);

module.exports = router;

const router = require('express').Router();
const ctrl = require('../controllers/owner.controller');
const { authenticatePwa, requireRoles } = require('../middlewares/pwaAuth.middleware');
const { buildUploader } = require('../../middlewares/upload.middleware');

const contractUpload = buildUploader('pwa-contracts', {
  allowed: /pdf|jpg|jpeg|png|application\/pdf|image\/jpeg|image\/png/,
  message: 'Only PDF, JPG, JPEG, and PNG files are allowed',
});
const sectionUploader = buildUploader('pwa-audits');
const sectionUpload = sectionUploader.array('photos', 50);

router.use(authenticatePwa, requireRoles('owner'));

// Owner dashboard — both self-onboarded and linked auditor-onboarded
// properties. Accepts ?source=self or ?source=auditor to filter.
router.get('/properties', ctrl.listMyProperties);
router.get('/properties/by-id/:id', ctrl.getOneById);
router.get('/properties/:code', ctrl.getOneByCode);

// Self-onboarding lifecycle (mirrors auditor: Phase 1 → 2 → 3 → 4 → submit).
router.post('/self-properties', ctrl.createSelfProperty);
router.post('/self-properties/:id/generate-id', ctrl.generateSelfId);
router.put('/self-properties/:id/sections/:sectionKey', sectionUpload, ctrl.upsertSelfSection);
router.post('/self-properties/:id/submit', ctrl.submitSelfForReview);
// Single-photo helper for per-room blocks on owner self-onboarding.
router.post('/self-properties/:id/upload-one', sectionUploader.single('photo'), ctrl.uploadOneSelfPhoto);
router.get('/self-properties/:id/phase4', ctrl.getSelfPhase4);
router.put('/self-properties/:id/phase4/:sectionKey', ctrl.upsertSelfPhase4Section);
router.post('/self-properties/:id/phase4/submit', ctrl.submitSelfPhase4);

// Signed-contract upload (available on auditor-onboarded properties once
// the contract has been released to the owner).
router.post(
  '/properties/:code/sign-upload',
  contractUpload.single('signed'),
  ctrl.uploadSignedContract,
);
// id-keyed variant used by the self-onboarding flow's signed-upload page.
router.post(
  '/self-properties/:id/sign-upload',
  contractUpload.single('signed'),
  ctrl.uploadSignedContractById,
);
// Stream the onboarding contract PDF for inline preview / download.
router.get('/properties/by-id/:id/contract/pdf', ctrl.downloadContractPdf);
router.get('/properties/:code/contract/pdf', ctrl.downloadContractPdfByCode);

// Check-Availability leads
router.get('/leads', ctrl.listMyLeads);
router.post('/leads/:leadId/respond', ctrl.respondToLead);

module.exports = router;

const router = require('express').Router();
const ctrl = require('../controllers/admin.controller');
const listingCtrl = require('../controllers/listing.controller');
const { authenticate } = require('../../middlewares/auth.middleware');
const { buildUploader } = require('../../middlewares/upload.middleware');

const upload = buildUploader('pwa-profiles');

// All admin PWA routes require an authenticated site admin.
router.use(authenticate);

// Website listing — configure & publish onboarded properties.
router.get('/listings/queue', listingCtrl.listQueue);
router.get('/listings/listed', listingCtrl.listListed);
router.get('/listings/:id', listingCtrl.getOne);
router.get('/listings-process', listingCtrl.onProcess);
router.put('/listings/:id/config', listingCtrl.saveConfig);
router.post('/listings/:id/publish', listingCtrl.publish);
router.post('/listings/:id/unlist', listingCtrl.unlist);

// Auditors
router.get('/auditors', ctrl.listAuditors);
router.post('/auditors', upload.single('profilePhoto'), ctrl.createAuditor);
router.get('/auditors/:id', ctrl.getAuditor);
router.put('/auditors/:id', upload.single('profilePhoto'), ctrl.updateAuditor);
router.patch('/auditors/:id/toggle', ctrl.toggleAuditor);
router.post('/auditors/:id/reset-password', ctrl.resetAuditorPassword);

// Officers
router.get('/officers', ctrl.listOfficers);
router.post('/officers', upload.single('profilePhoto'), ctrl.createOfficer);
router.get('/officers/:id', ctrl.getOfficer);
router.put('/officers/:id', upload.single('profilePhoto'), ctrl.updateOfficer);
router.patch('/officers/:id/toggle', ctrl.toggleOfficer);
router.post('/officers/:id/reset-password', ctrl.resetOfficerPassword);

// Signed owner contracts
router.get('/signed-properties', ctrl.listSignedProperties);
router.get('/signed-properties/:id/download', ctrl.downloadSignedProperty);

// Final listing images (read-only viewer)
router.get('/listing-images', ctrl.listPropertiesWithListingImages);
router.get('/listing-images/:propertyId', ctrl.getListingImagesForProperty);

// Salespersons
router.get('/salespersons', ctrl.listSalespersons);
router.post('/salespersons', upload.single('profilePhoto'), ctrl.createSalesperson);
router.get('/salespersons/:id', ctrl.getSalesperson);
router.put('/salespersons/:id', upload.single('profilePhoto'), ctrl.updateSalesperson);
router.patch('/salespersons/:id/toggle', ctrl.toggleSalesperson);
router.post('/salespersons/:id/reset-password', ctrl.resetSalespersonPassword);

// All availability leads (admin overview)
router.get('/leads', ctrl.listAllLeads);

// Property owners lookup (used by package admin form)
router.get('/owners', ctrl.listOwners);

module.exports = router;

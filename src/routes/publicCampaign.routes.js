const router = require('express').Router();
const { authenticateUser } = require('../middlewares/userAuth.middleware');
const ctrl = require('../controllers/campaign.controller');

/*
  The opt-out surface for occasion greetings.

  Unsubscribe is intentionally UNAUTHENTICATED — it is clicked from an email
  footer, often on a device that is not signed in, and forcing a login before
  someone can stop marketing mail is exactly how a domain earns spam reports.
  The HMAC token in the link is the authorisation (utils/unsubscribeToken.js),
  and it can only ever do this one thing.
*/
/*
  Engagement pixels, also unauthenticated — they are loaded by a mail client
  and by a static page, neither of which has a session. Both always answer
  with a 1x1 GIF, so a bad token is a no-op rather than a broken image.
*/
router.get('/t/open.gif', ctrl.trackOpen);
router.get('/t/click.gif', ctrl.trackClick);
// Fired by the website itself once the destination page has rendered, and
// again as it unloads. POST is what navigator.sendBeacon sends.
router.get('/t/land.gif', ctrl.trackLand);
router.get('/t/dwell', ctrl.trackDwell);
router.post('/t/dwell', ctrl.trackDwell);

router.get('/unsubscribe', ctrl.unsubscribe);
router.post('/unsubscribe', ctrl.unsubscribe);

// Turning greetings back on requires being signed in as that user.
router.post('/resubscribe', authenticateUser, ctrl.resubscribe);

module.exports = router;

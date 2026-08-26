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
router.get('/unsubscribe', ctrl.unsubscribe);
router.post('/unsubscribe', ctrl.unsubscribe);

// Turning greetings back on requires being signed in as that user.
router.post('/resubscribe', authenticateUser, ctrl.resubscribe);

module.exports = router;

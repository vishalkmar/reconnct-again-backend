const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/campaign.controller');

/*
  Admin → Occasion Marketing (festival / weekend / birthday greetings).
  Admin-only: this is the one screen that can mail the entire customer base.
*/
router.use(authenticate);

router.get('/', ctrl.list);
router.get('/upcoming', ctrl.upcomingSchedule);
router.get('/analytics', ctrl.analytics);
// The named list behind the percentages — who opened, clicked, stayed, booked.
router.get('/recipients', ctrl.recipients);

router.post('/', ctrl.create);
router.post('/seed', ctrl.seed);
router.post('/run-now', ctrl.runNow);
// Puts existing occasions onto the 7-day countdown (-7/-3/-2/-1/0).
router.post('/apply-countdown', ctrl.applyCountdownToAll);

router.put('/:id', ctrl.update);
router.patch('/:id/toggle', ctrl.toggle);
router.patch('/:id/verify-dates', ctrl.verifyDates);
router.post('/:id/test', ctrl.test);
router.delete('/:id', ctrl.remove);

module.exports = router;

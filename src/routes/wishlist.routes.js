const router = require('express').Router();
const ctrl = require('../controllers/wishlist.controller');
const { authenticateUser } = require('../middlewares/userAuth.middleware');

// All wishlist operations require a signed-in user.
router.use(authenticateUser);

router.get('/', ctrl.list);
router.get('/keys', ctrl.keys);
router.post('/', ctrl.add);
router.delete('/', ctrl.remove);

module.exports = router;

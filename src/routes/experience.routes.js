const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/experience.controller');

router.get('/', authenticate, c.list);
router.put('/reorder', authenticate, c.reorder); // before /:id so it isn't swallowed
router.get('/:id', authenticate, c.getOne);
router.post('/', authenticate, c.create);
router.put('/:id', authenticate, c.update);
router.post('/:id/duplicate', authenticate, c.duplicate);
router.patch('/:id/toggle', authenticate, c.toggle);
router.delete('/:id', authenticate, c.remove);

module.exports = router;

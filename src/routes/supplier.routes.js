const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/supplier.controller');

router.get('/', authenticate, c.list);
router.get('/:id', authenticate, c.getOne);
router.post('/', authenticate, c.create);
router.put('/:id', authenticate, c.update);
router.patch('/:id/toggle', authenticate, c.toggle);
router.delete('/:id', authenticate, c.remove);

module.exports = router;

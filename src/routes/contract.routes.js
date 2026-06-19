const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/contract.controller');

router.get('/', authenticate, c.list);
router.get('/:id', authenticate, c.getOne);
router.get('/:id/pdf', authenticate, c.downloadPdf);
router.get('/:id/word', authenticate, c.downloadWord);
router.post('/', authenticate, c.create);
router.put('/:id', authenticate, c.update);
router.delete('/:id', authenticate, c.remove);

module.exports = router;

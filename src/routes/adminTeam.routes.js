const router = require('express').Router();
const { authenticate } = require('../middlewares/auth.middleware');
const c = require('../controllers/teamMember.controller');

// Admin-only — creating/managing internal staff accounts and their
// permission toggles. Mounted at /api/admin/team.
router.use(authenticate);

router.get('/meta', c.meta);
router.get('/', c.list);
router.get('/:id', c.getOne);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;

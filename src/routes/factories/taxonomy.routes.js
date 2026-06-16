const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth.middleware');
const { buildUploader } = require('../../middlewares/upload.middleware');

/**
 * Build a fully-mounted Express router for a taxonomy controller.
 * `subfolder` controls where uploaded images are stored.
 */
const buildTaxonomyRouter = (ctrl, subfolder) => {
  const router = Router();
  const upload = buildUploader(subfolder);

  // Public
  router.get('/', ctrl.listPublic);

  // Admin
  router.get('/all', authenticate, ctrl.listAll);
  router.put('/reorder', authenticate, ctrl.reorder); // before /:id to avoid the param swallowing it
  router.get('/:id', authenticate, ctrl.getOne);
  router.post('/', authenticate, upload.single('image'), ctrl.create);
  router.put('/:id', authenticate, upload.single('image'), ctrl.update);
  router.patch('/:id/toggle', authenticate, ctrl.toggle);
  router.delete('/:id', authenticate, ctrl.remove);

  return router;
};

module.exports = { buildTaxonomyRouter };

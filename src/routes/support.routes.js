const router = require('express').Router();
const asyncHandler = require('express-async-handler');
const ctrl = require('../controllers/support.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateUser } = require('../middlewares/userAuth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');
const { getUploadedUrl } = require('../utils/uploads');
const { ok, fail } = require('../utils/response');

// Accept EITHER an admin (Authorization) or a party (X-User-Auth) token, so one
// attachments endpoint serves both sides.
const authenticateAny = (req, res, next) =>
  (req.headers.authorization ? authenticate : authenticateUser)(req, res, next);

// Images + PDF only for chat attachments.
const attachmentUploader = buildUploader('support', {
  allowed: /jpeg|jpg|png|gif|webp|pdf/,
  message: 'Only images or PDF files are allowed',
});

// POST /api/support/attachments  (party or admin) — returns { type, url, name, size }
router.post(
  '/attachments',
  authenticateAny,
  ...attachmentUploader.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No file uploaded', 400);
    const isPdf = req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname || '');
    return ok(res, {
      type: isPdf ? 'pdf' : 'image',
      url: getUploadedUrl(req.file),
      name: req.file.originalname,
      size: req.file.size,
    }, 'Uploaded');
  }),
);

// ── Party (user / host) — X-User-Auth ────────────────────────────────────
router.get('/me/conversation', authenticateUser, ctrl.meConversation);
router.get('/me/messages', authenticateUser, ctrl.meMessages);
router.post('/me/messages', authenticateUser, ctrl.meSend);
router.post('/me/read', authenticateUser, ctrl.meRead);
router.get('/me/unread', authenticateUser, ctrl.meUnread);

// ── Admin — Authorization ────────────────────────────────────────────────
router.get('/admin/conversations', authenticate, ctrl.adminConversations);
router.get('/admin/conversations/:id/messages', authenticate, ctrl.adminMessages);
router.post('/admin/conversations/:id/messages', authenticate, ctrl.adminReply);
router.post('/admin/conversations/:id/read', authenticate, ctrl.adminRead);
router.patch('/admin/conversations/:id', authenticate, ctrl.adminUpdate);
router.get('/admin/unread', authenticate, ctrl.adminUnread);

module.exports = router;

const router = require('express').Router();
const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const ctrl = require('../controllers/support.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateUser } = require('../middlewares/userAuth.middleware');
const { buildUploader } = require('../middlewares/upload.middleware');
const { getUploadedUrl } = require('../utils/uploads');
const { ok, fail } = require('../utils/response');

// Accept an admin OR a party token on one endpoint. The mobile app sends the
// USER token on the Authorization header, so we can't just switch on the header
// name — decode the token and route by its `kind`.
const authenticateAny = (req, res, next) => {
  const raw = req.headers['x-user-auth'] || req.headers.authorization || '';
  const token = String(raw).replace(/^Bearer\s+/i, '');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return (decoded.kind === 'user' ? authenticateUser : authenticate)(req, res, next);
  } catch {
    return authenticateUser(req, res, next); // 401s cleanly
  }
};

// Images, PDF, or a voice-note recording for chat attachments.
const attachmentUploader = buildUploader('support', {
  allowed: /jpeg|jpg|png|gif|webp|pdf|m4a|mp3|mp4|wav|aac|ogg|webm|3gp/,
  message: 'Only images, PDF files, or a voice recording are allowed',
});

// POST /api/support/attachments  (party or admin) — returns { type, url, name, size }
router.post(
  '/attachments',
  authenticateAny,
  ...attachmentUploader.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No file uploaded', 400);
    const isPdf = req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname || '');
    const isAudio = !isPdf && (
      req.file.mimetype?.startsWith('audio/') || /\.(m4a|mp3|wav|aac|ogg|webm|3gp)$/i.test(req.file.originalname || '')
    );
    let url = getUploadedUrl(req.file);
    // Serve PDFs as a download (correct filename, opens in the device viewer)
    // instead of an inline render that the browser's PDF viewer chokes on.
    if (isPdf && url.includes('/upload/')) url = url.replace('/upload/', '/upload/fl_attachment/');
    return ok(res, {
      type: isPdf ? 'pdf' : isAudio ? 'audio' : 'image',
      url,
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

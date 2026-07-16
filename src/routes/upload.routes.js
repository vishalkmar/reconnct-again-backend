const router = require('express').Router();
const asyncHandler = require('express-async-handler');
const { authenticate } = require('../middlewares/auth.middleware');
const { authenticateUser } = require('../middlewares/userAuth.middleware');
const { authenticateStaff } = require('../middlewares/staffAuth.middleware');
const { authenticateUserOrSupplier } = require('../middlewares/supplierAuth.middleware');
const { buildUploader, MAX_IMAGE_MB, MAX_IMAGE_BYTES } = require('../middlewares/upload.middleware');
const { getUploadedUrl } = require('../utils/uploads');
const { ok, fail } = require('../utils/response');

const uploader = buildUploader('inline');
const avatarUploader = buildUploader('user-avatars', {
  allowed: /jpeg|jpg|png|gif|webp/,
  message: 'Only image files are allowed',
});
// Documents (e.g. B2B contracts) — PDFs and common doc/image formats.
const documentUploader = buildUploader('documents', {
  allowed: /pdf|doc|docx|jpeg|jpg|png|webp/,
  message: 'Only PDF, DOC/DOCX or image files are allowed',
});

// POST /api/uploads/inline  (admin OR a permitted team member) — single
// image used inline in rich-text editors and by the supplier/experience
// forms' image droppers. Returns the public URL.
router.post(
  '/inline',
  authenticateStaff,
  uploader.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No file uploaded', 400);
    const url = getUploadedUrl(req.file);
    return ok(res, { url }, 'Uploaded');
  })
);

// POST /api/uploads/document  (admin) — single document (PDF/DOC/image), e.g.
// a supplier's B2B contract. Returns the public URL.
router.post(
  '/document',
  authenticate,
  documentUploader.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No file uploaded', 400);
    const url = getUploadedUrl(req.file);
    return ok(res, { url, name: req.file.originalname }, 'Uploaded');
  })
);

// GET /api/uploads/proxy-image?url=...  (admin) — server-side fetch of a
// remote image so the admin can "paste a link" in an uploader. Streaming the
// bytes back from our own origin sidesteps the browser CORS wall, letting the
// client turn the response into a File and run it through the normal upload
// pipeline. Guards: http(s) only, image content-type only, same global 5MB cap.
router.get(
  '/proxy-image',
  authenticateStaff,
  asyncHandler(async (req, res) => {
    const { url } = req.query;
    if (!url || !/^https?:\/\//i.test(url)) return fail(res, 'A valid http(s) image URL is required', 400);
    let upstream;
    try {
      upstream = await fetch(url, {
        redirect: 'follow',
        headers: {
          // Many hosts (e.g. Wikimedia) reject requests without a real UA.
          'User-Agent': 'Mozilla/5.0 (compatible; TraveonAdmin/1.0; +https://traveon.com)',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
    } catch {
      return fail(res, 'Could not reach that URL', 400);
    }
    if (!upstream.ok) return fail(res, `Fetch failed (${upstream.status})`, 400);
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return fail(res, 'That URL is not an image', 400);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return fail(res, `Image too large (max ${MAX_IMAGE_MB}MB)`, 400);
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'no-store');
    return res.send(buf);
  })
);

// POST /api/uploads/user-avatar  (signed-in user) — profile photo upload.
// Returns the public Cloudinary URL the caller can persist on its profile.
router.post(
  '/user-avatar',
  authenticateUser,
  avatarUploader.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No file uploaded', 400);
    const url = getUploadedUrl(req.file);
    return ok(res, { url }, 'Uploaded');
  })
);

// POST /api/uploads/user-image  (signed-in user OR a supplier's own login) —
// general image upload used by the "Switch to Host" listing wizard AND the
// Supplier Portal's identical wizard (cover + gallery photos). Returns the URL.
const hostImageUploader = buildUploader('host-listings', {
  allowed: /jpeg|jpg|png|gif|webp/,
  message: 'Only image files are allowed',
});
router.post(
  '/user-image',
  authenticateUserOrSupplier,
  hostImageUploader.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No file uploaded', 400);
    const url = getUploadedUrl(req.file);
    return ok(res, { url }, 'Uploaded');
  })
);

module.exports = router;

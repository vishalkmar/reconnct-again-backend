const path = require('path');
const fs = require('fs');
const { cloudinary, ROOT_FOLDER } = require('../config/cloudinary');

/*
  Unified upload helpers.

  - getUploadedUrl(file)  : Returns the persistent URL for a multer-parsed file.
                            With our Cloudinary upload middleware, multer attaches
                            the Cloudinary `secure_url` to file.path, so we just
                            return that. Backward-compat: if a legacy local file
                            sneaks in (file.filename + req.file.path on disk),
                            we still build a /uploads/... path.
  - removeUploadedFile(url) : Deletes a previously-uploaded file. Detects whether
                              it was a Cloudinary URL or a legacy /uploads/...
                              path and routes to the correct deletion.
*/

const getUploadedUrl = (file) => {
  if (!file) return null;
  // Our Cloudinary middleware sets file.path to the secure_url
  if (file.path && /^https?:\/\//i.test(file.path)) return file.path;
  // Legacy local fallback
  if (file.filename) {
    const sub = file.uploadSubfolder || 'misc';
    return `/uploads/${sub}/${file.filename}`;
  }
  return null;
};

const extractCloudinaryPublicId = (url) => {
  // https://res.cloudinary.com/<cloud>/<image|video>/upload/v123/<folder>/<file>.<ext>
  const m = /\/(?:image|video|raw)\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i.exec(url);
  return m ? m[1] : null;
};

const isCloudinaryUrl = (url) => /^https?:\/\/res\.cloudinary\.com\//i.test(url);

const removeUploadedFile = async (url) => {
  if (!url) return;

  if (isCloudinaryUrl(url)) {
    const publicId = extractCloudinaryPublicId(url);
    if (!publicId) return;
    const isVideo = /\/video\/upload\//.test(url);
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: isVideo ? 'video' : 'image',
        invalidate: true,
      });
    } catch (err) {
      // Swallow — deletion is best-effort
    }
    return;
  }

  // Legacy local file
  if (url.startsWith('/uploads/')) {
    const filePath = path.join(process.cwd(), url.replace(/^\//, ''));
    try { fs.unlinkSync(filePath); } catch {}
  }
};

module.exports = {
  getUploadedUrl,
  removeUploadedFile,
  isCloudinaryUrl,
  ROOT_FOLDER,
};

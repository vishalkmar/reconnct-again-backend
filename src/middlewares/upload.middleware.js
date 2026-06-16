const multer = require('multer');
const path = require('path');
const { cloudinary, ROOT_FOLDER, isConfigured } = require('../config/cloudinary');

const MAX_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);

const DEFAULT_ALLOWED = /jpeg|jpg|png|gif|webp|svg|mp4|webm|mov|avi/;

const createFileFilter = ({
  allowed = DEFAULT_ALLOWED,
  message = 'Only image and video files are allowed',
} = {}) => (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const ok = allowed.test(ext) || allowed.test(file.mimetype);
  if (ok) cb(null, true);
  else cb(new Error(message));
};

// Memory storage — files held in RAM until streamed to Cloudinary
const storage = multer.memoryStorage();

const createMulter = (options) => multer({
  storage,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: createFileFilter(options),
});

const cloudinaryPublicId = (file, resourceType) => {
  if (resourceType !== 'raw') return undefined;
  const ext = path.extname(file.originalname || '').toLowerCase() || '.pdf';
  const base = path
    .basename(file.originalname || 'signed-contract', ext)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'signed-contract';
  return `${base}-${Date.now()}${ext}`;
};

/**
 * Upload a single buffer to Cloudinary, returning the secure URL.
 */
const streamUploadBuffer = (buffer, { folder, resourceType, file }) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        public_id: cloudinaryPublicId(file, resourceType),
        use_filename: resourceType !== 'raw',
        unique_filename: true,
        overwrite: false,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    stream.end(buffer);
  });

const guessResourceType = (file) => {
  if (file.mimetype === 'application/pdf') return 'raw';
  if (/\.pdf$/i.test(file.originalname)) return 'raw';
  if (file.mimetype?.startsWith('video/')) return 'video';
  if (/\.(mp4|webm|mov|avi)$/i.test(file.originalname)) return 'video';
  return 'image';
};

/**
 * After multer parses files into memory, push each one to Cloudinary
 * and attach the secure URL to file.path so downstream code can read
 * a uniform `file.path` regardless of storage backend.
 */
const cloudinaryStreamUploader = (subfolder) => async (req, res, next) => {
  try {
    const folder = `${ROOT_FOLDER}/${subfolder}`;

    const uploadOne = async (file) => {
      if (!file?.buffer) return;
      const resourceType = guessResourceType(file);
      if (resourceType === 'raw') {
        file.emailAttachmentBuffer = Buffer.from(file.buffer);
      }
      const result = await streamUploadBuffer(file.buffer, {
        folder,
        resourceType,
        file,
      });
      file.path = result.secure_url;
      file.cloudinaryPublicId = result.public_id;
      file.cloudinaryResourceType = resourceType;
      file.uploadSubfolder = subfolder;
      // Free memory
      file.buffer = null;
    };

    if (req.file) await uploadOne(req.file);

    if (req.files) {
      // req.files can be an array (multer.array) or an object keyed by field name (multer.fields)
      if (Array.isArray(req.files)) {
        for (const f of req.files) await uploadOne(f);
      } else {
        for (const fieldName of Object.keys(req.files)) {
          for (const f of req.files[fieldName]) await uploadOne(f);
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Build an uploader for a specific subfolder. Returns an object whose
 * `single(field)`, `array(field, max)` and `fields(spec)` mirror multer's
 * API but include the Cloudinary upload step.
 */
const buildUploader = (subfolder = 'misc', options = {}) => {
  if (!isConfigured()) {
    console.warn('[CLOUDINARY] credentials missing — uploads will fail until set in .env');
  }
  const cloudinaryStep = cloudinaryStreamUploader(subfolder);
  const upload = createMulter(options);

  return {
    single: (field) => [upload.single(field), cloudinaryStep],
    array: (field, max) => [upload.array(field, max), cloudinaryStep],
    fields: (spec) => [upload.fields(spec), cloudinaryStep],
  };
};

module.exports = { buildUploader };

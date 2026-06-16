const { cloudinary, ROOT_FOLDER, isConfigured } = require('../../config/cloudinary');

/*
  Upload a server-generated PDF Buffer (e.g. from contractPdf.js) straight
  to Cloudinary as a `raw` resource. Returns the secure URL we then store
  on Contract.generatedPdfUrl so the auditor can preview / send later.
*/
const uploadContractPdf = ({ buffer, filename }) =>
  new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(new Error('Cloudinary is not configured'));
    }
    const safeName = (filename || `contract-${Date.now()}.pdf`)
      .replace(/[^a-z0-9_.-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${ROOT_FOLDER}/pwa-contracts`,
        resource_type: 'raw',
        public_id: safeName,
        use_filename: true,
        unique_filename: true,
        overwrite: false,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result?.secure_url || null);
      },
    );
    stream.end(buffer);
  });

module.exports = { uploadContractPdf };

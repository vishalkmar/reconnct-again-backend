/*
  Shared rules that every experience-submission path must satisfy before it can
  go for review — regardless of who submits (admin, BD, host web/app, supplier
  web/app). Enforced server-side so the rule holds globally even if a client
  (e.g. the mobile app) forgets to check.
*/

const MIN_IMAGES = 6;

// Total usable images = main image + gallery images.
const countImages = (exp) => {
  const gallery = Array.isArray(exp?.gallery) ? exp.gallery.filter(Boolean) : [];
  const main = exp?.mainImage ? 1 : 0;
  return main + gallery.length;
};

// Returns an error string if the images requirement isn't met, else null.
const validateImagesForSubmit = (exp) => {
  if (!exp?.mainImage) return 'A main image is required before submitting for review.';
  const total = countImages(exp);
  if (total < MIN_IMAGES) {
    return `At least ${MIN_IMAGES} images are required before submitting for review (you have ${total}).`;
  }
  return null;
};

module.exports = { MIN_IMAGES, countImages, validateImagesForSubmit };

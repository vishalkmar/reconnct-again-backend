/*
  The QCOPS on-site feedback form — the fields a Quality-Check Ops person fills
  after physically visiting the experience's point/place. Shared so the app/web
  form and the backend validation use the exact same field set.

  Field types the client renders:
    - rating  : 1–5 stars
    - boolean : Yes / No
    - select  : one of `options`
    - text    : free text
*/
const QC_FEEDBACK_FIELDS = [
  { key: 'locationAccurate', label: 'Is the location accurate & easy to find?', type: 'boolean', required: true },
  { key: 'matchesListing', label: 'Does the place match the listing (photos, description)?', type: 'rating', required: true },
  { key: 'facilities', label: 'Are the listed facilities actually available?', type: 'rating', required: true },
  { key: 'cleanliness', label: 'Cleanliness & upkeep', type: 'rating', required: true },
  { key: 'safety', label: 'Safety & hygiene standards', type: 'rating', required: true },
  { key: 'staff', label: 'Staff professionalism & readiness', type: 'rating', required: true },
  { key: 'accessibility', label: 'Accessibility (parking, entry, signage)', type: 'rating', required: false },
  { key: 'valueForMoney', label: 'Is the pricing fair for what’s offered?', type: 'boolean', required: true },
  { key: 'overallRating', label: 'Overall quality rating', type: 'rating', required: true },
  { key: 'recommendation', label: 'Your recommendation', type: 'select', options: ['approve', 'needs_improvement', 'reject'], required: true },
  { key: 'comments', label: 'Additional comments / observations', type: 'text', required: false },
];

const QC_FIELD_KEYS = QC_FEEDBACK_FIELDS.map((f) => f.key);
const QC_FIELD_BY_KEY = Object.fromEntries(QC_FEEDBACK_FIELDS.map((f) => [f.key, f]));

// Validate + normalise a submitted feedback object. Returns { error } or { feedback }.
const validateQcFeedback = (input) => {
  if (!input || typeof input !== 'object') return { error: 'Feedback is required' };
  const out = {};
  for (const f of QC_FEEDBACK_FIELDS) {
    const v = input[f.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required) return { error: `“${f.label}” is required` };
      out[f.key] = f.type === 'text' ? '' : null;
      continue;
    }
    if (f.type === 'rating') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 5) return { error: `“${f.label}” must be a rating 1–5` };
      out[f.key] = Math.round(n);
    } else if (f.type === 'boolean') {
      out[f.key] = !!v;
    } else if (f.type === 'select') {
      if (!f.options.includes(v)) return { error: `“${f.label}” has an invalid value` };
      out[f.key] = v;
    } else {
      out[f.key] = String(v).slice(0, 2000);
    }
  }
  return { feedback: out };
};

module.exports = { QC_FEEDBACK_FIELDS, QC_FIELD_KEYS, QC_FIELD_BY_KEY, validateQcFeedback };

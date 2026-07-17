/*
  Section registry for the granular Center Ops (COPS) review flow.

  Instead of approving/rejecting a whole experience in one shot, COPS reviews
  it section-by-section (the same sections the builder form is split into).
  This file is the single source of truth for:
    - which sections exist and in what order,
    - a human label per section,
    - a `present(exp)` predicate deciding whether a given experience actually
      HAS that section filled in (empty sections aren't reviewable and don't
      count toward the "all approved" gate).

  The per-section decisions are stored on `experience.reviewSections` as:
    { [key]: { decision: 'approved' | 'objection', objection: string|null,
               at: ISOString, by: teamMemberId|null } }
  A section with no entry (or decision not set) is treated as 'pending'.
*/

const has = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

// Ordered list. `duration` is deliberately its own section (the user calls it
// out separately) even though it lives inside the pricing JSON in the form.
const SECTIONS = [
  { key: 'basic', label: 'Basic details', present: () => true },
  { key: 'taxonomy', label: 'Category & audience', present: (e) => has(e.categoryIds) || has(e.audiences) || has(e.categoryId) },
  { key: 'supplier', label: 'Supplier', present: (e) => has(e.supplierId) },
  { key: 'about', label: 'About', present: (e) => has(e.about) },
  { key: 'media', label: 'Photos & videos', present: (e) => has(e.mainImage) || has(e.gallery) || has(e.videos) },
  { key: 'pricing', label: 'Pricing', present: (e) => has(e.priceMethod) || (e.pricing && Object.keys(e.pricing).length > 0) },
  { key: 'duration', label: 'Duration', present: (e) => !!(e.pricing && e.pricing.duration && (e.pricing.duration.hours || e.pricing.duration.minutes)) },
  { key: 'schedule', label: 'Availability & slots', present: (e) => !!(e.schedule && Array.isArray(e.schedule.dates) && e.schedule.dates.length) },
  { key: 'inclusions', label: 'Inclusions', present: (e) => has(e.inclusions) },
  { key: 'facilities', label: 'Facilities', present: (e) => has(e.facilities) },
  { key: 'nearby', label: 'Nearby places', present: (e) => has(e.nearbyPlaces) },
  { key: 'faqs', label: 'FAQs', present: (e) => has(e.faqs) },
  { key: 'policies', label: 'Policies & terms', present: (e) => has(e.termsConditions) || has(e.privacyPolicy) || has(e.refundCancellationPolicy) || has(e.refundPolicy) || has(e.cancellationPolicy) },
];

const SECTION_KEYS = SECTIONS.map((s) => s.key);
const LABEL_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s.label]));

// Resolve the experience to a plain object regardless of whether a Sequelize
// instance or a POJO was passed.
const toPlain = (exp) => (exp && typeof exp.toJSON === 'function' ? exp.toJSON() : exp || {});

// The sections that actually apply to THIS experience (have content).
const applicableSections = (exp) => {
  const e = toPlain(exp);
  return SECTIONS.filter((s) => {
    try { return s.present(e); } catch { return false; }
  }).map((s) => ({ key: s.key, label: s.label }));
};

const decisionOf = (reviewSections, key) => {
  const entry = reviewSections && reviewSections[key];
  if (!entry || !entry.decision) return 'pending';
  return entry.decision; // 'approved' | 'objection'
};

// A compact rollup used by both the queue list and the gate checks.
const summarize = (exp) => {
  const e = toPlain(exp);
  const rs = e.reviewSections || {};
  const applicable = applicableSections(e);
  let approved = 0;
  let objection = 0;
  let pending = 0;
  const objections = [];
  for (const s of applicable) {
    const d = decisionOf(rs, s.key);
    if (d === 'approved') approved += 1;
    else if (d === 'objection') {
      objection += 1;
      objections.push({ key: s.key, label: s.label, objection: rs[s.key]?.objection || '' });
    } else pending += 1;
  }
  return {
    total: applicable.length,
    approved,
    objection,
    pending,
    objections,
    allApproved: applicable.length > 0 && approved === applicable.length,
    hasObjection: objection > 0,
  };
};

// When a submitter sends a fixed item back for another round, previously
// APPROVED sections stay approved (COPS needn't redo them) while OBJECTION
// sections drop back to 'pending' so COPS re-decides only what was flagged.
const resetForNewRound = (reviewSections) => {
  const out = {};
  for (const [key, entry] of Object.entries(reviewSections || {})) {
    if (entry && entry.decision === 'approved') out[key] = entry;
    // objection / pending entries are dropped → treated as pending again
  }
  return out;
};

module.exports = {
  SECTIONS, SECTION_KEYS, LABEL_BY_KEY,
  applicableSections, decisionOf, summarize, resetForNewRound,
};

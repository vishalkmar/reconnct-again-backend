/*
  Canonical status derivation for an experience — the single source of truth
  for which TAB it belongs to, per audience, matching the Supplier-Onboarding
  flow (Excel):

  reviewStage lifecycle:
    content review (Level 1): null|submitted|in_review|resubmitted|follow_up
    content approved, pre-QC (still Level 1): approved
    QCOPS visit (Level 2): qc_assigned|qc_acknowledged|qc_onsite|qc_feedback
    QCOPS passed, awaiting go-live (Level 3): qc_passed
    changes negotiation: under_progress
    final: published/live | rejected | qc_rejected | delisted

  Audiences:
    - submitter (BD / host / supplier who added it): In Queue | Under Progress |
      Live | Rejected | Delisted
    - cops: level1 | level2 | live_in_progress | under_progress | active |
      rejected | delisted
    - qcops: (via qcReview) active-visit | awaiting-decision | approved |
      rejected | delisted
*/

const CONTENT_REVIEW = ['submitted', 'in_review', 'resubmitted', 'follow_up'];
const QC_VISIT = ['qc_assigned', 'qc_acknowledged', 'qc_onsite', 'qc_feedback'];

const isLive = (exp) => exp.reviewStage === 'live' || (exp.status === 'published' && exp.isActive);
const isRejected = (exp) => ['rejected', 'qc_rejected'].includes(exp.reviewStage) || (exp.status === 'archived' && exp.reviewStage !== 'delisted');

// Submitter tabs (BD / host / supplier).
const submitterTab = (exp) => {
  if (exp.reviewStage === 'delisted') return 'delisted';
  if (isLive(exp)) return 'live';
  if (isRejected(exp)) return 'rejected';
  if (exp.reviewStage === 'under_progress') return 'under_progress';
  return 'in_queue'; // anything still moving through content review / QC
};

// Center Ops levels.
const copsTab = (exp) => {
  if (exp.reviewStage === 'delisted') return 'delisted';
  if (isLive(exp)) return 'active';
  if (isRejected(exp)) return 'rejected';
  if (exp.reviewStage === 'under_progress') return 'under_progress';
  if (exp.reviewStage === 'qc_passed') return 'live_in_progress';
  if (QC_VISIT.includes(exp.reviewStage)) return 'level2';
  return 'level1'; // submitted/in_review/resubmitted/follow_up/approved
};

// QCOPS outcome tab (for the Listing Management view).
const qcopsTab = (exp) => {
  if (exp.reviewStage === 'delisted') return 'delisted';
  if (isLive(exp)) return 'approved';
  if (isRejected(exp)) return 'rejected';
  if (['qc_assigned', 'qc_acknowledged', 'qc_onsite'].includes(exp.reviewStage)) return 'active';
  return 'awaiting_decision'; // qc_feedback | qc_passed | under_progress
};

const SUBMITTER_TABS = ['in_queue', 'under_progress', 'live', 'rejected', 'delisted'];
const COPS_TABS = ['level1', 'level2', 'live_in_progress', 'under_progress', 'active', 'rejected', 'delisted'];

module.exports = {
  CONTENT_REVIEW, QC_VISIT, isLive, isRejected,
  submitterTab, copsTab, qcopsTab, SUBMITTER_TABS, COPS_TABS,
};

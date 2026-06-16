// One-time seeder for the 20 default audit-checklist items. Runs on every
// server boot but only inserts rows if the table is empty — admin edits are
// preserved across restarts.
const { ChecklistItem } = require('../models');

const DEFAULTS = [
  { label: 'Practitioner credentials', iconName: 'BadgeCheck',
    description: 'Every yoga teacher, therapist and practitioner is verified for qualifications and active certifications before being listed.' },
  { label: 'Program design quality', iconName: 'ClipboardCheck',
    description: 'Retreat programs are reviewed for pacing, balance, and outcomes — not just packed schedules.' },
  { label: 'Food & nutrition standards', iconName: 'Utensils',
    description: 'Menus are checked for diet variety (vegan, sattvic, gluten-free, allergen-aware) and quality sourcing.' },
  { label: 'Hygiene & safety', iconName: 'Sparkles',
    description: 'Property hygiene SOPs, water purity, kitchen cleanliness and pest control are independently audited.' },
  { label: 'Guest intake protocols', iconName: 'ClipboardList',
    description: 'Health screening, medical history forms and pre-arrival consultations are in place where relevant.' },
  { label: 'Emergency response plan', iconName: 'Siren',
    description: 'Documented evacuation, first-aid, and nearest-hospital protocols are tested by every property.' },
  { label: 'Honest marketing', iconName: 'MessageSquare',
    description: 'No exaggerated cures, no fake before/after photos. What the website says is what you get.' },
  { label: 'Pricing transparency', iconName: 'CreditCard',
    description: 'All-inclusive vs add-on, taxes, tipping norms — disclosed up-front, no surprises at check-out.' },
  { label: 'Refund policy', iconName: 'RefreshCcw',
    description: 'Clear, written refund terms tied to cancellation timing. Standardised across listed properties.' },
  { label: 'Accessibility', iconName: 'Accessibility',
    description: 'Mobility, dietary and language accessibility marked clearly on every listing.' },
  { label: 'Environmental practices', iconName: 'Leaf',
    description: 'Plastic-reduction, energy use, water reuse and waste handling reviewed during onboarding.' },
  { label: 'Guest privacy', iconName: 'Lock',
    description: 'Data we collect is encrypted and never sold. Properties are bound by our privacy contract.' },
  { label: 'Cancellation SLAs', iconName: 'CalendarX',
    description: 'Properties acknowledge cancellations within 24 hours and process refunds within published windows.' },
  { label: 'Reviews authenticity', iconName: 'Star',
    description: 'Every review is moderated and tied to a verified guest. No paid placements, ever.' },
  { label: 'Insurance', iconName: 'Umbrella',
    description: 'Listed properties carry guest-liability cover; we surface this on each detail page.' },
  { label: 'AYUSH / relevant certifications', iconName: 'Award',
    description: 'For Ayurvedic and traditional-wellness offerings, AYUSH (or country equivalent) certifications are verified.' },
  { label: 'Physical infrastructure', iconName: 'Building2',
    description: 'Buildings, electricals, fire safety and accessibility audited annually.' },
  { label: 'Digital presence accuracy', iconName: 'Globe',
    description: 'Listing copy, images and amenities are matched against on-site reality at audit time.' },
  { label: 'Staff training', iconName: 'GraduationCap',
    description: 'Frontline staff trained in hospitality, hygiene, first-aid and cultural sensitivity.' },
  { label: 'Post-stay follow-up', iconName: 'MessageCircle',
    description: 'A wellness check-in 7 days after your stay — to address concerns and capture honest feedback.' },
];

const seed = async () => {
  const count = await ChecklistItem.count();
  if (count > 0) return { inserted: 0, skipped: 'already populated' };

  const rows = DEFAULTS.map((d, i) => ({ ...d, sortOrder: i, isActive: true }));
  await ChecklistItem.bulkCreate(rows);
  return { inserted: rows.length };
};

module.exports = { seed };

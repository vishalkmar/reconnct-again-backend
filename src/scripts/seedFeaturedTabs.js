// Ensures the 4 fixed Featured Retreats tabs always exist as rows in the
// `featured_tabs` table so the admin UI can edit them. Re-runs on every boot
// but is idempotent — only inserts the ones missing.
const { FeaturedTab } = require('../models');

const DEFAULTS = [
  {
    tabKey: 'all',
    label: 'All',
    sublabel: 'Everything in one place',
    headline: 'Discover every wellness experience we curate',
    subheadline: 'Hotels, packages and events together — find what fits you fastest.',
  },
  {
    tabKey: 'hotels',
    label: 'Hotels',
    sublabel: 'Restful stays',
    headline: 'Hand-picked wellness hotels',
    subheadline: 'Every property is audited for hygiene, service and quiet.',
  },
  {
    tabKey: 'packages',
    label: 'Packages',
    sublabel: 'Curated retreats',
    headline: 'Programs designed for real outcomes',
    subheadline: 'From 3-day resets to 21-day deep dives — led by certified practitioners.',
  },
  {
    tabKey: 'events',
    label: 'Events',
    sublabel: 'Live experiences',
    headline: 'Workshops, festivals and one-day retreats',
    subheadline: 'Discover events near you or build your trip around one.',
  },
];

const seed = async () => {
  let inserted = 0;
  for (const d of DEFAULTS) {
    const existing = await FeaturedTab.findOne({ where: { tabKey: d.tabKey } });
    if (!existing) {
      await FeaturedTab.create({ ...d, isActive: true });
      inserted += 1;
    }
  }
  return { inserted };
};

module.exports = { seed };

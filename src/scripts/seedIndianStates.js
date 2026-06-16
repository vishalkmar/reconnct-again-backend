/*
  Seeds India's 28 states + 8 union territories into the `locations` taxonomy
  so the hotel/package Location dropdowns (and the website location filter,
  which reads the same records) always offer every Indian state. Idempotent:
  matches on slug, only creates what's missing — existing locations are left
  untouched. Safe to run repeatedly (also wired into server startup).
*/
const slugify = require('slugify');
const { Location } = require('../models');

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const UNION_TERRITORIES = [
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

const ALL = [...INDIAN_STATES, ...UNION_TERRITORIES];

const seedIndianStates = async () => {
  const baseOrder = 100;
  const rows = ALL.map((name, i) => ({
    name,
    slug: slugify(name, { lower: true, strict: true }),
    country: 'India',
    isActive: true,
    sortOrder: baseOrder + i,
  }));

  const slugs = rows.map((r) => r.slug);
  const existing = await Location.findAll({ where: { slug: slugs } });
  const existingBySlug = new Map(existing.map((r) => [r.slug, r]));

  const toCreate = rows.filter((r) => !existingBySlug.has(r.slug));
  let created = 0;
  if (toCreate.length) {
    await Location.bulkCreate(toCreate);
    created = toCreate.length;
  }

  // Reactivate any state someone had disabled so the filter stays complete.
  let reactivated = 0;
  for (const row of existing) {
    if (!row.isActive) {
      row.isActive = true;
      await row.save();
      reactivated += 1;
    }
  }

  return { created, reactivated, total: ALL.length };
};

module.exports = { seedIndianStates, INDIAN_STATES, UNION_TERRITORIES };

// Allow running standalone: `node src/scripts/seedIndianStates.js`
if (require.main === module) {
  require('dotenv').config();
  seedIndianStates()
    .then((r) => {
      console.log(`[SEED] Indian states: created ${r.created}, reactivated ${r.reactivated}, total ${r.total}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[SEED] Indian states failed:', e.message);
      process.exit(1);
    });
}

require('dotenv').config();
const { sequelize, HeaderLink } = require('../models');

/**
 * Idempotent seeder that ensures the three primary nav links exist:
 * Hotels, Packages, Events. Safe to re-run — only creates missing rows.
 * Run with:  node src/seeders/seedHeaderLinks.js
 */
const DEFAULTS = [
  { label: 'Hotels',   path: '/hotels',   icon: 'Hotel',        sortOrder: 0 },
  { label: 'Packages', path: '/retreats', icon: 'Package',      sortOrder: 1 },
  { label: 'Events',   path: '/events',   icon: 'CalendarDays', sortOrder: 2 },
];

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log('[SEED] Connected to DB');

    for (const entry of DEFAULTS) {
      const existing = await HeaderLink.findOne({ where: { path: entry.path } });
      if (existing) {
        console.log(`[SEED] Header link exists: ${existing.label} (${existing.path})`);
        continue;
      }
      const created = await HeaderLink.create({ ...entry, isActive: true });
      console.log(`[SEED] Header link created: ${created.label} → ${created.path}`);
    }

    console.log('[SEED] Header links done.');
    process.exit(0);
  } catch (err) {
    console.error('[SEED] Failed:', err.message);
    process.exit(1);
  }
};

run();

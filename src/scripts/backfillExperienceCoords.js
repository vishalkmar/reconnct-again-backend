const { Experience } = require('../models');
const { geocodeAddress } = require('../services/geocode.service');

/*
  One-off (and re-runnable) backfill: geocode every experience that has an
  address but no lat-long yet, so "experiences near you" can sort by distance.
  Throttled inside geocodeAddress; a shared cache means a city is looked up once
  no matter how many listings share it.

  Run:  node src/scripts/backfillExperienceCoords.js
*/
const backfillExperienceCoords = async ({ log = () => {} } = {}) => {
  const rows = await Experience.findAll({
    attributes: ['id', 'name', 'location', 'nearbyLocation', 'city', 'pincode', 'latitude', 'longitude'],
  });
  const force = process.env.FORCE === '1';
  const todo = rows.filter((e) => (force || e.latitude == null || e.longitude == null)
    && (e.city || e.location || e.nearbyLocation));

  const cache = new Map();
  let done = 0; let failed = 0;
  for (const e of todo) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await geocodeAddress({
      location: e.location, nearbyLocation: e.nearbyLocation, city: e.city, pincode: e.pincode,
    }, cache);
    if (hit) {
      // eslint-disable-next-line no-await-in-loop
      await Experience.update({ latitude: hit.lat, longitude: hit.lon }, { where: { id: e.id } });
      done += 1;
      log(`  ✓ #${e.id} ${e.name} → ${hit.lat},${hit.lon} (${hit.source})`);
    } else {
      failed += 1;
      log(`  ✗ #${e.id} ${e.name} — could not geocode`);
    }
  }
  return { total: rows.length, attempted: todo.length, done, failed };
};

module.exports = { backfillExperienceCoords };

if (require.main === module) {
  require('dotenv').config();
  const { sequelize } = require('../config/database');
  backfillExperienceCoords({ log: (m) => console.log(m) })
    .then((r) => { console.log('[geocode-backfill]', JSON.stringify(r)); return sequelize.close(); })
    .catch((e) => { console.error('[geocode-backfill] failed:', e.message); process.exit(1); });
}

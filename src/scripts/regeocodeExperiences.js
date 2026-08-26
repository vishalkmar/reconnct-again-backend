/*
  Re-geocode experiences so "near you" distances are accurate.

  Why: older rows were placed at the CITY CENTROID (every listing in a city
  shared one point → the "kabhi 0.4km, kabhi 10km" wrongness). Now that we build
  the full address (location + city + state + pincode + India) and geocode that,
  this walks the catalogue and refreshes each row's lat/long.

  Usage:
    node src/scripts/regeocodeExperiences.js            # only rows missing coords
    node src/scripts/regeocodeExperiences.js --force     # re-geocode ALL rows
    node src/scripts/regeocodeExperiences.js --id 42     # a single experience

  Polite by design: geocode.service throttles Nominatim to ~1 req/sec, so a large
  catalogue takes a while — that's expected, let it run.
*/

const { sequelize } = require('../config/database');
const { Experience } = require('../models');
const { geocodeExperienceById } = require('../services/geocode.service');

const run = async () => {
  const force = process.argv.includes('--force');
  const idFlag = process.argv.indexOf('--id');
  const onlyId = idFlag !== -1 ? Number(process.argv[idFlag + 1]) : null;

  const where = {};
  if (onlyId) where.id = onlyId;

  const rows = await Experience.findAll({ where, attributes: ['id', 'name', 'city', 'state', 'latitude', 'longitude'], order: [['id', 'ASC']] });
  let done = 0; let skipped = 0;

  for (const r of rows) {
    const hasCoords = r.latitude != null && r.longitude != null;
    if (!force && hasCoords) { skipped += 1; continue; } // eslint-disable-line no-continue
    process.stdout.write(`#${r.id} ${String(r.name || '').slice(0, 40)} … `);
    // eslint-disable-next-line no-await-in-loop
    await geocodeExperienceById(r.id, { force: true });
    // eslint-disable-next-line no-await-in-loop
    const fresh = await Experience.findByPk(r.id, { attributes: ['latitude', 'longitude'] });
    console.log(fresh.latitude != null ? `→ ${fresh.latitude}, ${fresh.longitude}` : '→ (no match)');
    done += 1;
  }

  console.log(`\nRe-geocoded ${done} experience(s); skipped ${skipped} that already had coordinates.`);
  await sequelize.close();
  process.exit(0);
};

run().catch((e) => { console.error(e); process.exit(1); });

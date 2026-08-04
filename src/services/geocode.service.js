const { CITY_COORDS } = require('../controllers/geo.controller');

/*
  Turn an experience's address into coordinates so "experiences near you" can
  sort by real distance.

  Every experience carries a free-text address (location / nearbyLocation /
  city / pincode) but no lat-long — this fills that in. Nominatim (OpenStreetMap,
  free, no key) does the geocoding; when it can't resolve the messy address we
  fall back to the city centroid table the geo controller already ships. A
  per-run city cache keeps us from geocoding "Delhi" fifty times, and a polite
  throttle respects Nominatim's 1 req/sec rule.
*/

const UA = 'reconnct-app/1.0 (support@reconnct.app)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nominatim = async (query) => {
  if (typeof fetch !== 'function' || !query) return null;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1`,
      { headers: { 'User-Agent': UA } },
    );
    if (!r.ok) return null;
    const j = await r.json();
    if (Array.isArray(j) && j[0] && j[0].lat && j[0].lon) {
      return { lat: Number(j[0].lat), lon: Number(j[0].lon) };
    }
    return null;
  } catch { return null; }
};

// The candidate query strings, most-specific first. A landmark ("Baga Beach")
// or the pincode geocodes far more precisely than a bare city.
const candidates = ({ location, nearbyLocation, city, pincode }) => {
  const c = (city || '').trim();
  const out = [];
  const clean = (s) => (s || '').trim();
  if (clean(nearbyLocation)) out.push([clean(nearbyLocation), c].filter(Boolean).join(', '));
  if (clean(location) && clean(location).length <= 60) out.push([clean(location), c].filter(Boolean).join(', '));
  if (pincode && /\d{5,6}/.test(String(pincode))) out.push([String(pincode).trim(), c].filter(Boolean).join(', '));
  if (c) out.push(c);
  return [...new Set(out.filter(Boolean))];
};

/*
  Resolve one address to { lat, lon, source }.
  `cache` (optional Map) memoises exact query strings + city centroids across a
  batch run so we make the fewest possible network calls.
*/
const geocodeAddress = async (addr, cache) => {
  const cityKey = String(addr.city || '').toLowerCase().trim();

  // 1) Try each specific candidate through Nominatim (throttled, de-duped).
  for (const q of candidates(addr)) {
    const key = `q:${q.toLowerCase()}`;
    if (cache && cache.has(key)) { const v = cache.get(key); if (v) return { ...v, source: 'cache' }; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const hit = await nominatim(q);
    if (cache) cache.set(key, hit || null);
    // eslint-disable-next-line no-await-in-loop
    await sleep(1100); // be polite to Nominatim
    if (hit) return { ...hit, source: 'nominatim' };
  }

  // 2) Fall back to the known city centroid.
  const centroid = CITY_COORDS[cityKey];
  if (centroid) return { lat: centroid[0], lon: centroid[1], source: 'city' };

  return null;
};

/*
  Geocode ONE experience by id and save its lat-long — best-effort, fire-and-
  forget after a create/update so a new listing becomes "near you"-able without
  blocking the request. Skips if it already has coordinates and `force` is off.
*/
const geocodeExperienceById = async (id, { force = false } = {}) => {
  try {
    // eslint-disable-next-line global-require
    const { Experience } = require('../models');
    const e = await Experience.findByPk(id, {
      attributes: ['id', 'location', 'nearbyLocation', 'city', 'pincode', 'latitude', 'longitude'],
    });
    if (!e) return;
    if (!force && e.latitude != null && e.longitude != null) return;
    if (!e.city && !e.location && !e.nearbyLocation) return;
    const hit = await geocodeAddress({
      location: e.location, nearbyLocation: e.nearbyLocation, city: e.city, pincode: e.pincode,
    });
    if (hit) await Experience.update({ latitude: hit.lat, longitude: hit.lon }, { where: { id } });
  } catch (err) { console.error('[geocode] experience', id, 'failed:', err.message); }
};

module.exports = { geocodeAddress, candidates, geocodeExperienceById };

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
    // countrycodes=in biases results to India so a street/landmark resolves to
    // the right place instead of a same-named spot abroad.
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=in&addressdetails=0`,
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

// The candidate query strings, MOST-SPECIFIC first, so we land on the exact
// address before ever falling back to the city. The full combined string
// (address, landmark, city, state, pincode, India) is tried first — that's what
// pins "D-Mall 128 Netaji Subhash Place, Delhi" to its real spot rather than the
// Delhi centroid.
const candidates = ({
  location, nearbyLocation, city, state, pincode,
}) => {
  const clean = (s) => (s || '').trim();
  const c = clean(city);
  const st = clean(state);
  const pin = pincode && /\d{5,6}/.test(String(pincode)) ? String(pincode).trim() : '';
  const out = [];
  // 1) The whole address, most precise.
  out.push([clean(location), clean(nearbyLocation), c, st, pin, 'India'].filter(Boolean).join(', '));
  // 2) Landmark / street + city + state.
  if (clean(nearbyLocation)) out.push([clean(nearbyLocation), c, st, 'India'].filter(Boolean).join(', '));
  if (clean(location) && clean(location).length <= 80) out.push([clean(location), c, st, 'India'].filter(Boolean).join(', '));
  // 3) Pincode (very precise on its own in India) + city.
  if (pin) out.push([pin, c, 'India'].filter(Boolean).join(', '));
  // 4) City + state (last resort before the centroid table).
  if (c) out.push([c, st, 'India'].filter(Boolean).join(', '));
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
      attributes: ['id', 'location', 'nearbyLocation', 'city', 'state', 'pincode', 'latitude', 'longitude'],
    });
    if (!e) return;
    if (!force && e.latitude != null && e.longitude != null) return;
    if (!e.city && !e.location && !e.nearbyLocation) return;
    const hit = await geocodeAddress({
      location: e.location, nearbyLocation: e.nearbyLocation, city: e.city, state: e.state, pincode: e.pincode,
    });
    if (hit) await Experience.update({ latitude: hit.lat, longitude: hit.lon }, { where: { id } });
  } catch (err) { console.error('[geocode] experience', id, 'failed:', err.message); }
};

module.exports = { geocodeAddress, candidates, geocodeExperienceById };

const { Experience } = require('../models');

/*
  TEST-DATA ONLY. Spreads every experience across famous Delhi locations so the
  "near you" distance sorting can be exercised with real, varied coordinates
  (otherwise demo rows all geocode to one city centroid and show the same km).

  GUARDED by env: only runs when SEED_DELHI_TEST=1, so it can never touch real
  production data by accident. Deterministic (spot chosen by id) + idempotent
  (skips a row already seeded to its target pincode with coords), so leaving the
  flag on is safe — it won't re-scramble or re-geocode on every boot.

  Each row gets city=Delhi, a DIFFERENT pincode, and a full famous address; its
  coordinates are nulled so the coordinate backfill (which runs right after this
  at boot) re-geocodes it to that exact Delhi spot.
*/
const DELHI_SPOTS = [
  { place: 'India Gate', pincode: '110001', address: 'India Gate, Rajpath, New Delhi' },
  { place: 'Connaught Place', pincode: '110001', address: 'Connaught Place, New Delhi' },
  { place: 'Qutub Minar', pincode: '110030', address: 'Qutub Minar, Mehrauli, New Delhi' },
  { place: 'Red Fort', pincode: '110006', address: 'Red Fort, Netaji Subhash Marg, Chandni Chowk, Delhi' },
  { place: 'Lotus Temple', pincode: '110019', address: 'Lotus Temple, Kalkaji, New Delhi' },
  { place: 'Akshardham Temple', pincode: '110092', address: 'Swaminarayan Akshardham, Pandav Nagar, New Delhi' },
  { place: 'Hauz Khas Village', pincode: '110016', address: 'Hauz Khas Village, Hauz Khas, New Delhi' },
  { place: 'Select Citywalk', pincode: '110017', address: 'Select Citywalk, Saket, New Delhi' },
  { place: "Humayun's Tomb", pincode: '110013', address: "Humayun's Tomb, Nizamuddin East, New Delhi" },
  { place: 'Chandni Chowk', pincode: '110006', address: 'Chandni Chowk Market, Old Delhi' },
  { place: 'Sarojini Nagar Market', pincode: '110023', address: 'Sarojini Nagar Market, New Delhi' },
  { place: 'Karol Bagh', pincode: '110005', address: 'Ajmal Khan Road, Karol Bagh, New Delhi' },
  { place: 'Lajpat Nagar Central Market', pincode: '110024', address: 'Central Market, Lajpat Nagar, New Delhi' },
  { place: 'Nehru Place', pincode: '110019', address: 'Nehru Place, New Delhi' },
  { place: 'Dilli Haat', pincode: '110023', address: 'Dilli Haat, INA, New Delhi' },
  { place: 'Rajouri Garden', pincode: '110027', address: 'Rajouri Garden, New Delhi' },
  { place: 'Dwarka Sector 21', pincode: '110075', address: 'Sector 21, Dwarka, New Delhi' },
  { place: 'Rohini', pincode: '110085', address: 'Sector 3, Rohini, New Delhi' },
  { place: 'Shahdara', pincode: '110032', address: 'Shahdara, Delhi' },
  { place: 'Vasant Kunj', pincode: '110070', address: 'Vasant Kunj, New Delhi' },
];

const seed = async () => {
  if (process.env.SEED_DELHI_TEST !== '1') return { skipped: true };
  const rows = await Experience.findAll({ attributes: ['id', 'pincode', 'latitude', 'longitude'] });
  let assigned = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const spot = DELHI_SPOTS[r.id % DELHI_SPOTS.length];
    const already = r.pincode === spot.pincode && r.latitude != null && r.longitude != null;
    if (already) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await Experience.update({
      city: 'Delhi',
      pincode: spot.pincode,
      location: spot.address,
      nearbyLocation: spot.place,
      latitude: null,
      longitude: null, // → coordinate backfill re-geocodes to this exact spot
    }, { where: { id: r.id } });
    assigned += 1;
  }
  return { total: rows.length, assigned };
};

module.exports = { seed, DELHI_SPOTS };

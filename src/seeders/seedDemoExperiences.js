/**
 * Seed demo Experiences so every broad category and every type has content
 * (images + all fields filled) — used to make the mobile app look complete.
 *
 * Idempotent: each row is matched by slug and tagged `data.demo = true`, so
 * re-running never duplicates, and they can be cleaned up later with:
 *   DELETE FROM experiences WHERE JSON_EXTRACT(data,'$.demo') = true;
 *
 *   npm run seed:demo
 */
require('dotenv').config();
const slugify = require('slugify');
const {
  sequelize, Experience, ExperienceCategory, ExperienceType, ExperienceAudience, Supplier,
} = require('../models');

const slug = (s) => slugify(String(s), { lower: true, strict: true });

const PLACES = [
  { location: 'Rishikesh', city: 'Uttarakhand' },
  { location: 'Goa', city: 'India' },
  { location: 'Manali', city: 'Himachal Pradesh' },
  { location: 'Jaipur', city: 'Rajasthan' },
  { location: 'Munnar', city: 'Kerala' },
  { location: 'Udaipur', city: 'Rajasthan' },
  { location: 'Coorg', city: 'Karnataka' },
  { location: 'Leh', city: 'Ladakh' },
  { location: 'Pondicherry', city: 'Tamil Nadu' },
  { location: 'Shillong', city: 'Meghalaya' },
  { location: 'Bali', city: 'Indonesia' },
  { location: 'Pokhara', city: 'Nepal' },
  { location: 'Cappadocia', city: 'Turkey' },
  { location: 'Mumbai', city: 'Maharashtra' },
];

const REVIEW_NAMES = ['Aisha K.', 'Tom W.', 'Rahul M.', 'Sophia L.', 'Arjun P.', 'Mei C.', 'Daniel R.', 'Neha S.'];
const REVIEW_TEXTS = [
  'Absolutely magical — exceeded every expectation!',
  'Best experience of my entire trip. Highly recommend!',
  'Well organised, friendly hosts and stunning views.',
  'A perfect mix of relaxation and adventure. Loved it.',
  'Great value for money. Will definitely come back.',
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

const INCLUSIONS_POOL = [
  'Professional guide', 'All equipment', 'Travel insurance', 'Instant confirmation',
  'Free cancellation', 'Local insights', 'Refreshments', 'Pickup & drop',
  'Certified instructor', 'Photos & memories',
];
const FACILITIES_POOL = ['Restrooms', 'Parking', 'Locker', 'First aid', 'Cafe', 'Wi-Fi'];

const pick = (arr, i) => arr[i % arr.length];
const money = (i) => [799, 1100, 1500, 1850, 2400, 2800, 3500, 4200, 5500, 7500, 9900, 12500][i % 12];

const run = async () => {
  await sequelize.authenticate();
  console.log('[SEED:demo] Connected to DB');

  const [categories, types, audiences, suppliers] = await Promise.all([
    ExperienceCategory.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC']] }),
    ExperienceType.findAll({ where: { isActive: true } }),
    ExperienceAudience.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC']] }),
    Supplier.findAll({ limit: 20 }).catch(() => []),
  ]);

  const audienceIds = audiences.map((a) => a.id);
  const typesByCat = {};
  types.forEach((t) => { (typesByCat[t.categoryId] = typesByCat[t.categoryId] || []).push(t); });

  let created = 0; let skipped = 0; let n = 0;

  for (const cat of categories) {
    const catTypes = typesByCat[cat.id] || [];
    for (const type of catTypes) {
      const place = pick(PLACES, n);
      const name = `${type.name} in ${place.location}`;
      const theSlug = slug(`${name}-demo`);

      const exists = await Experience.findOne({ where: { slug: theSlug } });
      if (exists) { skipped++; n++; continue; }

      const adultPrice = money(n);
      const auds = [pick(audienceIds, n), pick(audienceIds, n + 3)].filter((v, i, a) => a.indexOf(v) === i);
      const inclusions = INCLUSIONS_POOL.slice(0, 5 + (n % 3)).map((title) => ({ kind: 'included', title }));
      const faqs = [
        { question: 'What should I bring?', answer: 'Comfortable clothing, water and a sense of adventure. Everything else is provided.' },
        { question: 'Is it suitable for beginners?', answer: 'Yes — our guides tailor the experience for all levels.' },
        { question: 'What is the cancellation policy?', answer: 'Free cancellation up to 24 hours before the start time.' },
      ];
      const reviews = [0, 1, 2].map((k) => ({
        name: pick(REVIEW_NAMES, n + k),
        rating: 5 - (k % 2),
        date: `${pick(MONTHS, n + k)} ${10 + ((n + k) % 18)}`,
        text: pick(REVIEW_TEXTS, n + k),
      }));

      // Unsplash (reachable on-device; picsum was timing out). Themed-ish pool.
      const IMGS = [
        '1517836357463-d25dfeac3438', '1506905925346-21bda4d32df4', '1469854523086-cc02fe5d8800',
        '1533105079780-92b9be482077', '1530789253388-582c481c54b0', '1507525428034-b723cf961d3e',
        '1540206395-68808572332f', '1464822759023-fed622ff2c3b', '1488646953014-85cb44e25828',
        '1497436072909-60f360e1d4b1', '1476514525535-07fb3b4ae5f1', '1454496522488-7a8e488e8606',
      ];
      const U = (id) => `https://images.unsplash.com/photo-${id}?w=800&q=80`;
      const mainImage = U(IMGS[n % IMGS.length]);
      const gallery = [1, 2, 3].map((g) => U(IMGS[(n + g) % IMGS.length]));

      await Experience.create({
        name,
        slug: theSlug,
        audiences: auds,
        categoryId: cat.id,
        typeId: type.id,
        supplierId: suppliers.length ? pick(suppliers, n).id : null,
        location: place.location,
        city: place.city,
        nearbyLocation: `${place.location} town centre`,
        rating: (4.3 + ((n % 7) * 0.1)).toFixed(1),
        about: `Immerse yourself in an unforgettable ${type.name.toLowerCase()} experience in ${place.location}, ${place.city}. `
          + `Led by passionate local hosts, you'll discover hidden gems and make lasting memories. `
          + `Perfect for solo travellers, couples, families and groups seeking authentic ${cat.name.toLowerCase()} moments.`,
        mainImage,
        gallery,
        videos: [],
        mode: 'offline',
        status: 'published',
        priceMethod: 'per_person',
        pricing: {
          adultPrice,
          childrenEnabled: true,
          childBands: [
            { startAge: 0, endAge: 5, charge: false, price: 0 },
            { startAge: 6, endAge: 12, charge: true, price: Math.round(adultPrice * 0.5) },
          ],
          duration: { hours: 2 + (n % 5), minutes: 0 },
        },
        currency: 'INR',
        gstRate: 5,
        discount: n % 4 === 0 ? { type: 'percentage', value: 10 } : null,
        convenienceFee: n % 3 === 0 ? { type: 'percentage', value: 2 } : { type: 'fixed', value: 49 },
        inclusions,
        faqs,
        facilities: FACILITIES_POOL.slice(0, 3 + (n % 3)),
        nearbyPlaces: [
          { name: `${place.location} viewpoint`, distanceKm: 2 + (n % 5) },
          { name: `${place.location} market`, distanceKm: 1 + (n % 3) },
        ],
        refundCancellationPolicy: 'Free cancellation up to 24 hours before the experience starts. '
          + 'Cancellations within 24 hours are non-refundable.',
        termsConditions: 'Please arrive 15 minutes early. Participants must follow safety guidance from the host at all times.',
        schedule: {
          availableDays: ['Mon', 'Wed', 'Fri', 'Sat', 'Sun'],
          timeSlots: ['06:00 AM', '04:00 PM'],
          notice: 'Book at least 24 hours in advance',
          startDate: '2026-07-01',
          endDate: '2026-12-31',
        },
        data: {
          demo: true,
          capacity: 8 + (n % 13),
          reviewsCount: reviews.length,
          reviews,
        },
        isActive: true,
        isFeatured: n % 4 === 0,
        sortOrder: n,
      });
      created++; n++;
    }
  }

  console.log(`[SEED:demo] Created ${created}, skipped ${skipped} (already existed).`);
  console.log('[SEED:demo] DONE');
  process.exit(0);
};

run().catch((err) => { console.error('[SEED:demo] Failed:', err); process.exit(1); });

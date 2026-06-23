/**
 * Re-categorise the existing demo experiences onto the NEW Reconnct taxonomy
 * (audience-tagged categories + their types) so the mobile app matches the
 * admin taxonomy. Images and locations are kept; name / category / type /
 * audiences are updated. Distributes round-robin so every new category gets
 * at least one experience.
 *
 * Equivalent to editing each via the admin PUT — same writable columns.
 *
 *   npm run recat:demo   (or: node src/seeders/recategorizeDemoExperiences.js)
 */
require('dotenv').config();
const slugify = require('slugify');
const {
  sequelize, Experience, ExperienceCategory, ExperienceType, ExperienceAudience,
} = require('../models');

const run = async () => {
  await sequelize.authenticate();
  console.log('[recat] Connected to DB');

  // Audiences: slug → id
  const audRows = await ExperienceAudience.findAll();
  const audIdBySlug = {};
  audRows.forEach((a) => { audIdBySlug[a.slug] = a.id; });

  // New (tagged) categories only, ordered.
  const cats = (await ExperienceCategory.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] }))
    .filter((c) => Array.isArray(c.audiences) && c.audiences.length > 0);
  if (!cats.length) { console.error('[recat] No tagged categories — run seed:reconnct-taxonomy first.'); process.exit(1); }

  // Types grouped by category.
  const typeRows = await ExperienceType.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const typesByCat = {};
  typeRows.forEach((t) => { (typesByCat[t.categoryId] = typesByCat[t.categoryId] || []).push(t); });

  // Demo experiences, stable order.
  const exps = await Experience.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const demo = exps.filter((e) => e.data && e.data.demo);
  console.log(`[recat] ${demo.length} demo experiences, ${cats.length} categories`);

  const typeCursor = {}; // categoryId → next type index
  let updated = 0;

  for (let i = 0; i < demo.length; i++) {
    const exp = demo[i];
    const cat = cats[i % cats.length];
    const catTypes = typesByCat[cat.id] || [];
    if (!catTypes.length) continue;
    const ti = (typeCursor[cat.id] || 0) % catTypes.length;
    typeCursor[cat.id] = ti + 1;
    const type = catTypes[ti];

    const place = exp.location || exp.city || 'India';
    const name = `${type.name} in ${place}`;
    const audiences = (cat.audiences || []).map((s) => audIdBySlug[s]).filter(Boolean);
    const slug = `${slugify(name, { lower: true, strict: true })}-${exp.id}`;
    const about = `Experience ${type.name.toLowerCase()} in ${place}${exp.city && exp.city !== place ? `, ${exp.city}` : ''}. `
      + `A handpicked ${cat.name.toLowerCase()} experience — perfect for those looking to reconnect through ${type.name.toLowerCase()}.`;

    await exp.update({
      name,
      slug,
      categoryId: cat.id,
      typeId: type.id,
      audiences,
      about,
    });
    updated++;
  }

  console.log(`[recat] Updated ${updated} experiences onto the new taxonomy.`);
  console.log('[recat] DONE');
  process.exit(0);
};

run().catch((err) => { console.error('[recat] Failed:', err); process.exit(1); });

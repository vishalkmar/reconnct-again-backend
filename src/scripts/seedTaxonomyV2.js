const slugify = require('slugify');
const { ExperienceAudience, ExperienceCategory, ExperienceType } = require('../models');
const { AUDIENCES, CATEGORIES, TRIPLES } = require('./taxonomyData');

/*
  Replace the whole experience taxonomy with the FINAL Reconnect list (see
  taxonomyData.js). Everything on the platform — every form and every filter,
  on the website AND the mobile app, for users, hosts, suppliers, BD and admin —
  reads this taxonomy from the same three tables via the public/admin endpoints,
  so seeding the DATA updates all of them at once; there is nothing hardcoded to
  chase.

  Strategy (safe + idempotent):
    • upsert by slug — an existing audience/category/type with the same slug
      keeps its ID, so the 100 existing experiences that reference IDs never
      dangle for anything still present.
    • DEACTIVATE (isActive=false) anything not in the new set instead of
      deleting it — old rows vanish from every form/filter (they all query
      isActive:true) while their names still resolve for any historical
      experience that points at them.
    • categories are tagged with every audience slug they appear under, so the
      picker filters the 10 categories by the chosen audience.
*/

const slug = (s) => slugify(String(s), { lower: true, strict: true });

const seedTaxonomyV2 = async () => {
  const changes = [];

  // ── 1. Audiences ────────────────────────────────────────────────────
  const audienceIdBySlug = {};
  for (let i = 0; i < AUDIENCES.length; i += 1) {
    const name = AUDIENCES[i];
    const s = slug(name);
    // eslint-disable-next-line no-await-in-loop
    const [row] = await ExperienceAudience.findOrCreate({
      where: { slug: s },
      defaults: { name, slug: s, sortOrder: i, isActive: true, isCustom: false },
    });
    if (row.name !== name || row.sortOrder !== i || !row.isActive) {
      row.name = name; row.sortOrder = i; row.isActive = true;
      // eslint-disable-next-line no-await-in-loop
      await row.save();
    }
    audienceIdBySlug[s] = row.id;
  }
  const keepAudienceSlugs = AUDIENCES.map(slug);

  // ── 2. Categories (tagged with the audiences they appear under) ──────
  const catAudienceSlugs = {}; // categorySlug -> Set(audience slugs)
  for (const [aud, cat] of TRIPLES) {
    const cs = slug(cat);
    (catAudienceSlugs[cs] = catAudienceSlugs[cs] || new Set()).add(slug(aud));
  }
  const categoryIdBySlug = {};
  for (let i = 0; i < CATEGORIES.length; i += 1) {
    const name = CATEGORIES[i];
    const s = slug(name);
    const auds = [...(catAudienceSlugs[s] || new Set())];
    // eslint-disable-next-line no-await-in-loop
    const [row] = await ExperienceCategory.findOrCreate({
      where: { slug: s },
      defaults: { name, slug: s, audiences: auds, sortOrder: i, isActive: true, isCustom: false },
    });
    row.name = name; row.sortOrder = i; row.isActive = true; row.audiences = auds;
    // eslint-disable-next-line no-await-in-loop
    await row.save();
    categoryIdBySlug[s] = row.id;
  }
  const keepCategorySlugs = CATEGORIES.map(slug);

  // ── 3. Types (unique per category) ──────────────────────────────────
  const typeKeep = {}; // categoryId -> Set(type slugs kept)
  const seen = new Set();
  let order = 0;
  for (const [, cat, type] of TRIPLES) {
    const cs = slug(cat);
    const catId = categoryIdBySlug[cs];
    const ts = slug(type);
    const key = `${catId}:${ts}`;
    if (seen.has(key)) continue; // eslint-disable-line no-continue
    seen.add(key);
    (typeKeep[catId] = typeKeep[catId] || new Set()).add(ts);
    order += 1;
    // eslint-disable-next-line no-await-in-loop
    const [row] = await ExperienceType.findOrCreate({
      where: { categoryId: catId, slug: ts },
      defaults: { categoryId: catId, name: type, slug: ts, sortOrder: order, isActive: true, isCustom: false },
    });
    if (row.name !== type || !row.isActive) {
      row.name = type; row.isActive = true;
      // eslint-disable-next-line no-await-in-loop
      await row.save();
    }
  }

  // ── 4. Deactivate everything not in the new set ─────────────────────
  const audAll = await ExperienceAudience.findAll();
  for (const a of audAll) {
    if (!keepAudienceSlugs.includes(a.slug) && a.isActive) {
      a.isActive = false; await a.save(); // eslint-disable-line no-await-in-loop
    }
  }
  const catAll = await ExperienceCategory.findAll();
  for (const c of catAll) {
    if (!keepCategorySlugs.includes(c.slug) && c.isActive) {
      c.isActive = false; await c.save(); // eslint-disable-line no-await-in-loop
    }
  }
  const typeAll = await ExperienceType.findAll();
  for (const t of typeAll) {
    const kept = typeKeep[t.categoryId] && typeKeep[t.categoryId].has(t.slug);
    if (!kept && t.isActive) {
      t.isActive = false; await t.save(); // eslint-disable-line no-await-in-loop
    }
  }

  changes.push(`audiences=${AUDIENCES.length}`, `categories=${CATEGORIES.length}`, `types=${seen.size}`);
  return { changes };
};

module.exports = { seedTaxonomyV2 };

// Allow a direct `node src/scripts/seedTaxonomyV2.js` run.
if (require.main === module) {
  require('dotenv').config();
  const { sequelize } = require('../config/database');
  seedTaxonomyV2()
    .then((r) => { console.log('[taxonomy-v2] done:', r.changes.join(', ')); return sequelize.close(); })
    .catch((e) => { console.error('[taxonomy-v2] failed:', e.message); process.exit(1); });
}

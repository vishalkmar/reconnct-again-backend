/*
 * Drops duplicate indexes that pile up because of `sequelize.sync({ alter:true })`.
 *
 * Sequelize's alter mode never checks if a UNIQUE/INDEX already exists before
 * adding it, so over many restarts MySQL tables accumulate dozens of identical
 * indexes (`email_2`, `email_3`, …). Eventually MySQL hits its 64-keys limit
 * and every ALTER blows up with ER_TOO_MANY_KEYS.
 *
 * Run once with:   npm run cleanup-indexes
 *
 * Strategy:
 *   - For every table the app owns, walk SHOW INDEXES.
 *   - Group by column-set; keep the lowest-named index, drop the rest.
 *   - PRIMARY is never touched.
 */

require('dotenv').config();
const { sequelize, connectDB } = require('../config/database');
require('../models');

const TABLES = [
  'admins', 'activities', 'blogs', 'blog_categories', 'blog_scenes',
  'categories', 'cities', 'header_links', 'heroes', 'hero_media',
  'package_categories', 'package_problems', 'package_activities',
  'package_images', 'package_reviews', 'packages', 'problems',
  'site_settings', 'testimonials', 'testimonial_media',
];

const tableExists = async (name) => {
  const [rows] = await sequelize.query(`SHOW TABLES LIKE :n`, { replacements: { n: name } });
  return rows.length > 0;
};

const fetchIndexes = async (table) => {
  const [rows] = await sequelize.query(`SHOW INDEX FROM \`${table}\``);
  return rows;
};

const dropIndex = async (table, name) => {
  await sequelize.query(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``);
};

const cleanTable = async (table) => {
  if (!(await tableExists(table))) return { table, kept: 0, dropped: 0, skipped: true };

  const rows = await fetchIndexes(table);

  // Group columns by index name → ordered column list
  const byName = new Map();
  for (const r of rows) {
    if (r.Key_name === 'PRIMARY') continue;
    if (!byName.has(r.Key_name)) byName.set(r.Key_name, { unique: r.Non_unique === 0, cols: [] });
    byName.get(r.Key_name).cols.push({ seq: r.Seq_in_index, name: r.Column_name });
  }

  // Build a signature per index ("col1|col2"), grouped
  const groups = new Map();
  for (const [name, { unique, cols }] of byName) {
    const sig = cols.sort((a, b) => a.seq - b.seq).map((c) => c.name).join('|') + (unique ? '#U' : '#I');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(name);
  }

  let dropped = 0;
  let kept = 0;
  for (const [sig, names] of groups) {
    names.sort(); // keep lowest-named (e.g. `email`, then drop `email_2`, `email_3`…)
    kept += 1;
    for (let i = 1; i < names.length; i++) {
      try {
        await dropIndex(table, names[i]);
        dropped += 1;
      } catch (err) {
        // Some indexes back FK constraints — don't kill the whole script over one
        console.warn(`  ! could not drop ${table}.${names[i]} (${err.original?.code || err.message})`);
      }
    }
    void sig;
  }

  return { table, kept, dropped, skipped: false };
};

const main = async () => {
  await connectDB();
  console.log('[CLEANUP] Pruning duplicate indexes…\n');

  let totalDropped = 0;
  for (const t of TABLES) {
    const r = await cleanTable(t);
    if (r.skipped) {
      console.log(`  · ${t} — skipped (table not present)`);
    } else {
      totalDropped += r.dropped;
      console.log(`  · ${t} — kept ${r.kept}, dropped ${r.dropped}`);
    }
  }

  console.log(`\n[CLEANUP] Done. Dropped ${totalDropped} duplicate indexes.`);
  await sequelize.close();
  process.exit(0);
};

main().catch((err) => {
  console.error('[CLEANUP] Failed:', err);
  process.exit(1);
});

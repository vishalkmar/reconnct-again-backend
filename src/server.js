require('dotenv').config();

const http = require('http');
const app = require('./app');
const { sequelize, connectDB } = require('./config/database');
require('./models'); // load models (incl. PWA via models/index.js)
const { initSocket } = require('./pwa/services/socket');
const { initSupportSocket } = require('./support/supportSocket');

const PORT = process.env.PORT || 5000;

const codeOf = (err) => err?.original?.code || err?.parent?.code || err?.code;

const isDeadlock = (err) =>
  codeOf(err) === 'ER_LOCK_DEADLOCK' || codeOf(err) === 'ER_LOCK_WAIT_TIMEOUT';

const isTooManyKeys = (err) => codeOf(err) === 'ER_TOO_MANY_KEYS';

/**
 * Drop duplicate indexes that `sync({alter:true})` accumulates across restarts.
 * Sequelize's alter mode re-issues `... UNIQUE` even when nothing changed, so
 * MySQL ends up with `email`, `email_2`, `email_3`, … and eventually trips
 * the 64-keys-per-table limit. We prune them on every startup so this cannot
 * snowball.
 */
const pruneDuplicateIndexes = async () => {
  const [tables] = await sequelize.query('SHOW TABLES');
  if (!tables.length) return 0;
  const dbField = Object.keys(tables[0])[0];

  let totalDropped = 0;
  for (const row of tables) {
    const table = row[dbField];
    let rows;
    try {
      [rows] = await sequelize.query(`SHOW INDEX FROM \`${table}\``);
    } catch {
      continue;
    }
    const byName = new Map();
    for (const r of rows) {
      if (r.Key_name === 'PRIMARY') continue;
      if (!byName.has(r.Key_name)) byName.set(r.Key_name, { unique: r.Non_unique === 0, cols: [] });
      byName.get(r.Key_name).cols.push({ seq: r.Seq_in_index, name: r.Column_name });
    }
    const groups = new Map();
    for (const [name, { unique, cols }] of byName) {
      const sig = cols.sort((a, b) => a.seq - b.seq).map((c) => c.name).join('|') + (unique ? '#U' : '#I');
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(name);
    }
    for (const names of groups.values()) {
      names.sort(); // keep the lowest-named (`email` over `email_2`)
      for (let i = 1; i < names.length; i++) {
        try {
          await sequelize.query(`ALTER TABLE \`${table}\` DROP INDEX \`${names[i]}\``);
          totalDropped += 1;
        } catch {
          /* some indexes back FK constraints — leave them alone */
        }
      }
    }
  }
  return totalDropped;
};

const syncWithRetry = async (opts, attempts = 5) => {
  for (let i = 0; i < attempts; i++) {
    try {
      await sequelize.sync(opts);
      return;
    } catch (err) {
      if (isDeadlock(err) && i < attempts - 1) {
        const wait = 1500 * (i + 1);
        console.warn(`[DB] Sync hit ${codeOf(err)} — retry ${i + 1}/${attempts} after ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (isTooManyKeys(err) && i < attempts - 1) {
        const dropped = await pruneDuplicateIndexes();
        console.warn(`[DB] ER_TOO_MANY_KEYS — pruned ${dropped} duplicate indexes, retrying…`);
        continue;
      }
      throw err;
    }
  }
};

/**
 * Heavy DB work — runs in the background AFTER the HTTP server is already
 * listening so the first API call doesn't have to wait for `ALTER TABLE` ×40.
 * If any step fails it logs and continues; the server is already serving.
 */
const runBackgroundDbWork = async () => {
  try {
    const dropped = await pruneDuplicateIndexes();
    if (dropped > 0) {
      console.log(`[DB] Cleaned up ${dropped} stale duplicate index${dropped > 1 ? 'es' : ''}`);
    }
  } catch (err) {
    console.warn('[DB] Index prune failed (non-fatal):', err.message);
  }

  try {
    const syncOpts = process.env.NODE_ENV === 'production' ? {} : { alter: true };
    await syncWithRetry(syncOpts);
    console.log('[DB] Models synchronized');
  } catch (err) {
    console.error('[DB] sync failed:', err.message);
  }

  // One-time data migrations run after sync. Each is idempotent.
  try {
    const { migrate: migratePwaSchema } = require('./scripts/migratePwaSchema');
    const result = await migratePwaSchema();
    if (result.changes?.length) {
      console.log(`[DB] PWA schema fixups: ${result.changes.join('; ')}`);
    }
  } catch (err) {
    console.warn('[DB] PWA schema migration failed (non-fatal):', err.message);
  }

  try {
    const { migrate: migrateHostSchema } = require('./scripts/migrateHostSchema');
    const result = await migrateHostSchema();
    if (result.changes?.length) {
      console.log(`[DB] Host schema fixups: ${result.changes.join('; ')}`);
    }
  } catch (err) {
    console.warn('[DB] Host schema migration failed (non-fatal):', err.message);
  }

  try {
    const { migrate: migrateExperienceReviews } = require('./scripts/migrateExperienceReviews');
    const result = await migrateExperienceReviews();
    if (result.changes?.length) {
      console.log(`[DB] Experience reviews schema fixups: ${result.changes.join('; ')}`);
    }
  } catch (err) {
    console.warn('[DB] Experience reviews migration failed (non-fatal):', err.message);
  }

  try {
    const { migrate: migratePaymentFailure } = require('./scripts/migratePaymentFailure');
    const result = await migratePaymentFailure();
    if (result.changes?.length) {
      console.log(`[DB] Payment failure schema fixups: ${result.changes.join('; ')}`);
    }
  } catch (err) {
    console.warn('[DB] Payment failure migration failed (non-fatal):', err.message);
  }

  try {
    const { migrate: migratePushTokens } = require('./scripts/migratePushTokens');
    const result = await migratePushTokens();
    if (result.changes?.length) {
      console.log(`[DB] Push token schema fixups: ${result.changes.join('; ')}`);
    }
  } catch (err) {
    console.warn('[DB] Push token migration failed (non-fatal):', err.message);
  }

  try {
    const { migrate: migrateExperienceTaxonomyArrays } = require('./scripts/migrateExperienceTaxonomyArrays');
    const result = await migrateExperienceTaxonomyArrays();
    if (result.changes?.length) {
      console.log(`[DB] Experience taxonomy array fixups: ${result.changes.join('; ')}`);
    }
  } catch (err) {
    console.warn('[DB] Experience taxonomy array migration failed (non-fatal):', err.message);
  }

  try {
    const { migrate: migrateScheduleData } = require('./scripts/migrateScheduleData');
    const result = await migrateScheduleData();
    if (result.changes?.length) {
      console.log(`[DB] Schedule data fixups: ${result.changes.join('; ')}`);
    }
  } catch (err) {
    console.warn('[DB] Schedule data migration failed (non-fatal):', err.message);
  }

  try {
    const { migrate: migrateReviews } = require('./scripts/migrateReviews');
    const result = await migrateReviews();
    if (result.copied) {
      console.log(`[DB] Migrated ${result.copied} legacy package_reviews row(s) into unified reviews table`);
    }
  } catch (err) {
    console.warn('[DB] Review migration failed (non-fatal):', err.message);
  }

  try {
    const { seed: seedChecklist } = require('./scripts/seedChecklist');
    const result = await seedChecklist();
    if (result.inserted) {
      console.log(`[DB] Seeded ${result.inserted} default checklist item(s)`);
    }
  } catch (err) {
    console.warn('[DB] Checklist seed failed (non-fatal):', err.message);
  }

  try {
    const { seedIndianStates } = require('./scripts/seedIndianStates');
    const result = await seedIndianStates();
    if (result.created || result.reactivated) {
      console.log(`[DB] Indian states: +${result.created} created, ${result.reactivated} reactivated`);
    }
  } catch (err) {
    console.warn('[DB] Indian states seed failed (non-fatal):', err.message);
  }

  try {
    const { seed: seedFeaturedTabs } = require('./scripts/seedFeaturedTabs');
    const result = await seedFeaturedTabs();
    if (result.inserted) {
      console.log(`[DB] Seeded ${result.inserted} featured tab row(s)`);
    }
  } catch (err) {
    console.warn('[DB] Featured tabs seed failed (non-fatal):', err.message);
  }

  console.log('[DB] Background tasks complete — schema fully synced');

  // Booking reminder sweep (12h-before / 2h-before emails, guest + host) —
  // runs every 10 minutes for the lifetime of this process. Started only
  // after migrations so the scheduledAt/reminder*SentAt columns definitely
  // exist by the time it queries them.
  const { sweepReminders } = require('./services/reminder.service');
  sweepReminders().catch((err) => console.error('[reminder] initial sweep failed:', err.message));
  setInterval(() => {
    sweepReminders().catch((err) => console.error('[reminder] sweep failed:', err.message));
  }, 10 * 60 * 1000);
};

const start = async () => {
  // 1) Only the bare minimum before listen: a working DB connection.
  await connectDB();

  // 2) Listen IMMEDIATELY. The previous version blocked here for several
  //    minutes while `sync({alter:true})` rewrote every table on each boot.
  //    APIs now respond in < 1s after the process starts; schema sync runs
  //    in the background.
  const httpServer = http.createServer(app);
  const io = initSocket(httpServer);
  initSupportSocket(io); // /support namespace (customer support chat)

  httpServer.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
    console.log(`[SERVER] API base: http://localhost:${PORT}/api`);
    console.log(`[SERVER] PWA API base: http://localhost:${PORT}/api/pwa`);
    console.log('[SERVER] Socket.io initialized');
    console.log('[SERVER] READY — accepting requests');
  });

  // 3) Schema sync, migrations and seeds — defer so the first request
  //    isn't blocked. Skip entirely with SKIP_SYNC=true.
  if (process.env.SKIP_SYNC === 'true') {
    console.log('[DB] Skipping sequelize.sync (SKIP_SYNC=true)');
    return;
  }
  setImmediate(() => {
    runBackgroundDbWork().catch((err) => {
      console.error('[DB] Background DB work crashed:', err);
    });
  });
};

start().catch((err) => {
  console.error('[SERVER] Failed to start:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

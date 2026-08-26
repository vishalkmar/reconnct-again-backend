/* eslint-disable no-console */
require('dotenv').config();
const { sequelize } = require('../models');

/*
  Adds the two `users` columns the occasion-greeting engine needs:

    anniversary        DATE  — the second personal occasion (dob is the first)
    marketingOptOutAt  DATETIME — set when someone unsubscribes

  Why this exists: server.js only runs sync({alter:true}) OUTSIDE production
  (see the syncOpts line). In production it runs sync({}), which creates the
  two NEW campaign tables just fine but will never add a column to a table
  that already exists. So on the live server, run this once:

      node src/scripts/addOccasionColumns.js

  Idempotent — it checks information_schema first and does nothing if the
  columns are already there.
*/

const COLUMNS = [
  { table: 'users', name: 'anniversary', ddl: 'ADD COLUMN `anniversary` DATE NULL AFTER `dob`' },
  { table: 'users', name: 'marketingOptOutAt', ddl: 'ADD COLUMN `marketingOptOutAt` DATETIME NULL AFTER `anniversary`' },
  // Only needed on a database where campaign_dispatches was created before
  // same-day occasion merging existed; a fresh install gets it from sync().
  {
    table: 'campaign_dispatches',
    name: 'mergedIntoCampaignId',
    ddl: 'ADD COLUMN `mergedIntoCampaignId` INT NULL',
  },
];

const run = async () => {
  await sequelize.authenticate();
  const dbName = sequelize.config.database;

  for (const col of COLUMNS) {
    const [tables] = await sequelize.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      { replacements: [dbName, col.table] }
    );
    if (!tables.length) {
      console.log(`[occasion-cols] ${col.table} does not exist yet — sync() will create it`);
      continue;
    }
    const [rows] = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      { replacements: [dbName, col.table, col.name] }
    );
    if (rows.length) {
      console.log(`[occasion-cols] ${col.table}.${col.name} already present — skipped`);
      continue;
    }
    await sequelize.query(`ALTER TABLE \`${col.table}\` ${col.ddl}`);
    console.log(`[occasion-cols] ${col.table}.${col.name} added`);
  }

  // The campaign tables are created by sync() on boot, but creating them here
  // too means this one script leaves the DB fully ready either way.
  const { CampaignEvent, CampaignDispatch } = require('../models');
  await CampaignEvent.sync();
  await CampaignDispatch.sync();
  console.log('[occasion-cols] campaign_events / campaign_dispatches ready');
};

run()
  .then(() => { console.log('[occasion-cols] done'); process.exit(0); })
  .catch((err) => { console.error('[occasion-cols] failed:', err.message); process.exit(1); });

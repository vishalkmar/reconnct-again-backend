/* eslint-disable no-console */
require('dotenv').config();
const { sequelize } = require('../models');
const { migrate } = require('./migrateOccasionSchema');

/*
  CLI wrapper:  npm run migrate:occasions

  The server now runs this same migration itself on every boot, before it
  starts listening (see server.js step 1b), so you normally never need this.
  It stays for the case where you want to fix a database WITHOUT restarting
  the API — or to check what state a DB is in.

  The DDL itself lives in migrateOccasionSchema.js so there is exactly one
  definition of these columns, not two that can drift apart.
*/
const run = async () => {
  await sequelize.authenticate();

  const result = await migrate();
  if (result.changes.length) {
    result.changes.forEach((c) => console.log(`[occasion-cols] ${c}`));
  } else {
    console.log('[occasion-cols] nothing to do — all columns already present');
  }

  // campaign_events / campaign_dispatches are new TABLES, which sync() does
  // create on its own; creating them here too means one command leaves the
  // database fully ready either way.
  const { CampaignEvent, CampaignDispatch } = require('../models');
  await CampaignEvent.sync();
  await CampaignDispatch.sync();
  console.log('[occasion-cols] campaign_events / campaign_dispatches ready');
};

run()
  .then(() => { console.log('[occasion-cols] done'); process.exit(0); })
  .catch((err) => { console.error('[occasion-cols] failed:', err.message); process.exit(1); });

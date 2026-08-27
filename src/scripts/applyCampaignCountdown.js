/* eslint-disable no-console */
require('dotenv').config();
const { sequelize, CampaignEvent } = require('../models');
const { applyCountdown, isOnCountdown } = require('../services/campaignCountdown.service');

/*
  Puts occasions that are ALREADY in the database onto the seven-day
  countdown (-7 / -3 / -2 / -1 / 0).

  Why this exists separately from the seeder: seeding is idempotent by slug
  and deliberately never overwrites a stored row, because an admin may have
  corrected its dates or rewritten its copy. That is the right rule — and it
  also means a calendar loaded before the countdown existed would keep its old
  two-beat schedule forever. This is the one-time upgrade for that.

  It only ever touches `sendOffsets` and the per-offset `channels`. Dates,
  copy and any hand-written offsetCopy are left exactly as they are.

    npm run campaigns:countdown            # the big (emailing) occasions
    npm run campaigns:countdown -- --all   # every festival/holiday/sale

  The same thing is a button in Admin → Occasion Marketing, which is the path
  to prefer in production — this is for a server shell.
*/
const run = async ({ scope = 'emailing', log = console.log } = {}) => {
  const rows = await CampaignEvent.findAll();
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const json = row.toJSON();
    const ramp = applyCountdown(json, { scope });
    if (!ramp || isOnCountdown(json)) { skipped += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    await row.update(ramp);
    updated += 1;
    log(`  ✓ ${json.name} → -7 / -3 / -2 / -1 / 0 on ${(json.channels || []).join(', ')}`);
  }

  log(`[countdown] ${updated} upgraded, ${skipped} left as they were`);
  return { updated, skipped };
};

module.exports = { run };

if (require.main === module) {
  (async () => {
    try {
      await sequelize.authenticate();
      const scope = process.argv.includes('--all') ? 'all' : 'emailing';
      console.log(`[countdown] scope: ${scope}`);
      await run({ scope });
      process.exit(0);
    } catch (err) {
      console.error('[countdown] failed:', err.message);
      process.exit(1);
    }
  })();
}

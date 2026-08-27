// Schema fixups for Occasion Marketing (festival / weekend / birthday
// greetings). Production runs sync WITHOUT { alter }, so a column added to an
// existing model is never created by sync — it just starts appearing in every
// SELECT and breaks the query. That is exactly what `users.anniversary` did:
// the moment the model shipped, every login blew up with
// "Unknown column 'anniversary' in 'field list'".
//
// Each step is idempotent — safe on a fresh DB, an already-migrated one, or a
// DB where only some of the columns exist.

const { sequelize } = require('../config/database');

const tableExists = async (name) => {
  try {
    const [rows] = await sequelize.query('SHOW TABLES LIKE :name', { replacements: { name } });
    return rows.length > 0;
  } catch {
    return false;
  }
};

const columnExists = async (table, column) => {
  try {
    const [rows] = await sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE :column`,
      { replacements: { column } },
    );
    return rows.length > 0;
  } catch {
    return false;
  }
};

const addColumnIfMissing = async (table, column, definition, summary) => {
  if (!(await tableExists(table))) return;
  if (await columnExists(table, column)) return;
  try {
    await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    summary.changes.push(`${table}.${column} column added`);
  } catch (err) {
    summary.changes.push(`${table}.${column} add failed: ${err.message}`);
  }
};

const migrate = async () => {
  const summary = { changes: [] };

  // The two that break authentication when missing — the User model selects
  // every column on every login, profile read and audience query.
  await addColumnIfMissing('users', 'anniversary', 'DATE NULL', summary);
  await addColumnIfMissing('users', 'marketingOptOutAt', 'DATETIME NULL', summary);

  // Only needed on a DB where campaign_dispatches was created before same-day
  // occasion merging existed; a fresh install gets it from sync().
  await addColumnIfMissing('campaign_dispatches', 'mergedIntoCampaignId', 'INT NULL', summary);

  /*
    Engagement tracking — the open/click funnel behind the analytics tab.
    Same reason as every column above: sync() without { alter } creates
    tables, never columns, so the moment the model listed these every
    SELECT on campaign_dispatches would fail with "Unknown column" — which
    on this table means the in-app notification bell goes down, not just a
    report.
  */
  await addColumnIfMissing('campaign_dispatches', 'openedAt', 'DATETIME NULL', summary);
  await addColumnIfMissing('campaign_dispatches', 'clickedAt', 'DATETIME NULL', summary);
  await addColumnIfMissing('campaign_dispatches', 'clickCount', 'INT NOT NULL DEFAULT 0', summary);
  await addColumnIfMissing('campaign_dispatches', 'clickKind', 'VARCHAR(12) NULL', summary);
  await addColumnIfMissing('campaign_dispatches', 'clickVia', 'VARCHAR(10) NULL', summary);

  return summary;
};

module.exports = { migrate };

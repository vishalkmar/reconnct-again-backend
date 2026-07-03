// Schema fixups for the "Switch to Host" feature. Production runs sync without
// { alter }, so newly-added columns must be created explicitly here. Each step
// is idempotent — safe to run on a fresh or already-migrated DB.

const { sequelize } = require('../config/database');

const tableExists = async (name) => {
  try {
    const [rows] = await sequelize.query('SHOW TABLES LIKE :name', { replacements: { name } });
    return rows.length > 0;
  } catch {
    return false;
  }
};

const describeColumn = async (table, column) => {
  try {
    const [rows] = await sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE :column`,
      { replacements: { column } },
    );
    return rows[0] || null;
  } catch {
    return null;
  }
};

const addColumnIfMissing = async (table, column, definition, summary) => {
  if (!(await tableExists(table))) return;
  const existing = await describeColumn(table, column);
  if (existing) return;
  try {
    await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    summary.changes.push(`${table}.${column} column added`);
  } catch (err) {
    summary.changes.push(`${table}.${column} add failed: ${err.message}`);
  }
};

const migrate = async () => {
  const summary = { changes: [] };
  // Host-created listings are owned by a User.
  await addColumnIfMissing('experiences', 'ownerUserId', 'INT NULL', summary);
  // Host business/company name on the user profile.
  await addColumnIfMissing('users', 'company', 'VARCHAR(180) NULL', summary);
  return summary;
};

module.exports = { migrate };

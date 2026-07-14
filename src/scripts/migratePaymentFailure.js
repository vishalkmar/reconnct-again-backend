const { sequelize } = require('../config/database');

/*
  Adds the columns needed to distinguish a genuinely FAILED payment from one
  that's just still pending:
    - bookings.paymentFailedAt (nullable) — set the moment we get an
      authoritative "this attempt is dead" signal (webhook FAIL/USER_DROPPED,
      or an EXPIRED/TERMINATED/CANCELLED order/link status), cleared the
      moment a later attempt succeeds.
    - bookings.lastPaymentStatus (nullable) — the raw status/event string, for
      support/debugging.
  Idempotent — safe to run on every boot.
*/

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
    const [rows] = await sequelize.query(`SHOW COLUMNS FROM \`${table}\` LIKE :column`, { replacements: { column } });
    return rows[0] || null;
  } catch {
    return null;
  }
};

const addColumnIfMissing = async (table, column, definition, changes) => {
  if (!(await tableExists(table))) return;
  if (await describeColumn(table, column)) return;
  try {
    await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    changes.push(`${table}.${column} column added`);
  } catch (err) {
    changes.push(`${table}.${column} add failed: ${err.message}`);
  }
};

const migrate = async () => {
  const changes = [];
  await addColumnIfMissing('bookings', 'paymentFailedAt', 'DATETIME NULL', changes);
  await addColumnIfMissing('bookings', 'lastPaymentStatus', 'VARCHAR(40) NULL', changes);
  return { changes };
};

module.exports = { migrate };

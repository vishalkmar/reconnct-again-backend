const { sequelize } = require('../config/database');

/*
  Phase 3 of the team/RBAC system — Center Ops (COPS) review queue.
    - experiences.reviewNote (nullable TEXT) — reject/changes-requested
      feedback shown back to whoever submitted it.
    - experiences.reviewedByTeamMemberId (nullable INT) — which COPS acted.
    - experiences.reviewedAt (nullable DATETIME).
    - experiences.qcopsTeamMemberId (nullable INT) — escalated-to QCOPS.
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
  await addColumnIfMissing('experiences', 'reviewNote', 'TEXT NULL', changes);
  await addColumnIfMissing('experiences', 'reviewedByTeamMemberId', 'INT NULL', changes);
  await addColumnIfMissing('experiences', 'reviewedAt', 'DATETIME NULL', changes);
  await addColumnIfMissing('experiences', 'qcopsTeamMemberId', 'INT NULL', changes);
  return { changes };
};

module.exports = { migrate };

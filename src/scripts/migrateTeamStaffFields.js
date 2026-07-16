const { sequelize } = require('../config/database');

/*
  Phase 2 of the team/RBAC system — lets a BD (or other permitted staff)
  create suppliers/experiences via the team portal, tagged with WHO created
  them and forced into a review gate before going live.
    - suppliers.createdByTeamMemberId (nullable) — null for admin-created rows.
    - experiences.createdByTeamMemberId (nullable) — same idea.
    - experiences.status ENUM gains 'pending_review' (MySQL needs an explicit
      MODIFY COLUMN for enum value changes — sequelize sync() doesn't reliably
      pick these up).
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

const ensureStatusEnumHasPendingReview = async (changes) => {
  if (!(await tableExists('experiences'))) return;
  const col = await describeColumn('experiences', 'status');
  if (!col) return;
  if (col.Type.includes('pending_review')) return;
  try {
    await sequelize.query(
      "ALTER TABLE `experiences` MODIFY COLUMN `status` ENUM('draft','pending_review','published','archived') NOT NULL DEFAULT 'draft'"
    );
    changes.push('experiences.status enum gained pending_review');
  } catch (err) {
    changes.push(`experiences.status enum alter failed: ${err.message}`);
  }
};

const migrate = async () => {
  const changes = [];
  await addColumnIfMissing('suppliers', 'createdByTeamMemberId', 'INT NULL', changes);
  await addColumnIfMissing('experiences', 'createdByTeamMemberId', 'INT NULL', changes);
  await ensureStatusEnumHasPendingReview(changes);
  return { changes };
};

module.exports = { migrate };

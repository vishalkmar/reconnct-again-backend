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

/*
  The maxSuppliers column first shipped with DEFAULT 30. The baseline was later
  fixed to 20 (and 20 is now a hard floor). This runs ONCE to drop the leftover
  old-default rows (30) down to 20.

  We can't guard on the column default: in dev the app runs sync({alter:true})
  BEFORE these migrations, and it already rewrote the default to 20 (the model's
  value) without touching existing rows — so "is the default still 30?" would
  wrongly skip. Instead we stamp a marker in the column COMMENT once the fix has
  run, and skip on any later boot. A MODIFY with no diff (default 20 already
  matches the model) never re-issues, so the marker survives — and a 30 an admin
  deliberately sets AFTER this is never reset.
*/
const BASELINE_MARKER = 'kam_baseline_v1';

const maxSuppliersComment = async () => {
  try {
    const [rows] = await sequelize.query("SHOW FULL COLUMNS FROM `team_members` LIKE 'maxSuppliers'");
    return rows[0] ? (rows[0].Comment || '') : null;
  } catch {
    return null;
  }
};

const ensureMaxSuppliersBaseline20 = async (changes) => {
  const comment = await maxSuppliersComment();
  if (comment === null) return; // column doesn't exist yet (shouldn't happen post-add).
  if (comment.includes(BASELINE_MARKER)) return; // already normalised once.
  try {
    await sequelize.query('UPDATE `team_members` SET `maxSuppliers` = 20 WHERE `maxSuppliers` = 30');
    await sequelize.query(
      `ALTER TABLE \`team_members\` MODIFY COLUMN \`maxSuppliers\` INT NOT NULL DEFAULT 20 COMMENT '${BASELINE_MARKER}'`
    );
    changes.push('team_members.maxSuppliers baseline normalised 30 → 20');
  } catch (err) {
    changes.push(`team_members.maxSuppliers baseline fix failed: ${err.message}`);
  }
};

const migrate = async () => {
  const changes = [];
  await addColumnIfMissing('suppliers', 'createdByTeamMemberId', 'INT NULL', changes);
  await addColumnIfMissing('experiences', 'createdByTeamMemberId', 'INT NULL', changes);
  // Per-KAM supplier cap (Account Manager role). Default & floor 20.
  await addColumnIfMissing('team_members', 'maxSuppliers', 'INT NOT NULL DEFAULT 20', changes);
  await ensureMaxSuppliersBaseline20(changes);
  await ensureStatusEnumHasPendingReview(changes);
  return { changes };
};

module.exports = { migrate };

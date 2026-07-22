const { sequelize } = require('../config/database');

/*
  Phase 4 of the team/RBAC system — a Supplier can get their own login and
  self-serve their own listings through a dashboard cloned from the Host
  system.
    - suppliers.password (nullable) — bcrypt hashed; null until someone
      (admin/BD, or later the supplier themself) sets one.
    - suppliers.lastLoginAt (nullable).
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
  await addColumnIfMissing('suppliers', 'password', 'VARCHAR(255) NULL', changes);
  await addColumnIfMissing('suppliers', 'lastLoginAt', 'DATETIME NULL', changes);
  // Device push token — so booking/reminder pushes reach a supplier's app.
  await addColumnIfMissing('suppliers', 'fcmToken', 'VARCHAR(255) NULL', changes);
  return { changes };
};

module.exports = { migrate };

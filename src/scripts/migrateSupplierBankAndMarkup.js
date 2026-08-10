const { sequelize } = require('../config/database');

/*
  Adds the columns introduced by the pricing/voucher batch:
    - suppliers.bankAccountName / bankName / bankAddress / accountNumber / ifscCode
      (settlement bank details collected at onboarding).
    - experiences.markup (JSON) — the go-live markup config applied on the B2B
      base before discount.
  childMode lives inside the `pricing` JSON, so it needs no column.
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
  await addColumnIfMissing('suppliers', 'bankAccountName', 'VARCHAR(240) NULL', changes);
  await addColumnIfMissing('suppliers', 'bankName', 'VARCHAR(200) NULL', changes);
  await addColumnIfMissing('suppliers', 'bankAddress', 'VARCHAR(400) NULL', changes);
  await addColumnIfMissing('suppliers', 'accountNumber', 'VARCHAR(60) NULL', changes);
  await addColumnIfMissing('suppliers', 'ifscCode', 'VARCHAR(40) NULL', changes);
  await addColumnIfMissing('experiences', 'markup', 'JSON NULL', changes);
  return { changes };
};

module.exports = { migrate };

// Allow running directly: `node src/scripts/migrateSupplierBankAndMarkup.js`
if (require.main === module) {
  migrate()
    .then((r) => { console.log('[migrate] done:', r.changes.length ? r.changes.join('; ') : 'nothing to change'); return sequelize.close(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[migrate] failed:', e.message); process.exit(1); });
}

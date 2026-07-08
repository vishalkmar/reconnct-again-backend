const { sequelize } = require('../config/database');

/*
  Adds Experience.categoryIds / Experience.typeIds (JSON arrays) alongside the
  existing single-valued categoryId/typeId columns, then backfills them from
  whatever scalar value each experience already has — so an experience that
  was single-category before the multi-select admin form still has that one
  category/type carried into its new array. Idempotent: only touches rows
  whose array is still empty.
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
  await addColumnIfMissing('experiences', 'categoryIds', 'JSON NULL', changes);
  await addColumnIfMissing('experiences', 'typeIds', 'JSON NULL', changes);

  let backfilled = 0;
  if (await tableExists('experiences')) {
    const { Experience } = require('../models');
    const rows = await Experience.findAll({ attributes: ['id', 'categoryId', 'typeId', 'categoryIds', 'typeIds'] });
    for (const row of rows) {
      const needsCategory = (!Array.isArray(row.categoryIds) || row.categoryIds.length === 0) && row.categoryId;
      const needsType = (!Array.isArray(row.typeIds) || row.typeIds.length === 0) && row.typeId;
      if (!needsCategory && !needsType) continue;
      // eslint-disable-next-line no-await-in-loop
      await row.update({
        categoryIds: needsCategory ? [row.categoryId] : (row.categoryIds || []),
        typeIds: needsType ? [row.typeId] : (row.typeIds || []),
      });
      backfilled += 1;
    }
  }
  if (backfilled) changes.push(`${backfilled} experience(s) backfilled categoryIds/typeIds from their scalar category/type`);

  return { changes };
};

module.exports = { migrate };

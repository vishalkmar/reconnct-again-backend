// One-time PWA schema fixups that `sequelize.sync({alter:true})` doesn't
// reliably apply. Each step is idempotent — running it on a fresh DB or on
// an already-migrated DB is safe.
//
// Why this file exists: MySQL's NOT NULL constraint isn't always relaxed by
// Sequelize's alter mode when a model column flips `allowNull: false -> true`.
// Same story for newly-added ENUM values. We do the explicit ALTERs here so
// owner self-onboarding (which inserts a property with `auditorId = NULL`
// and `source = 'self'`) actually works without manual SQL.

const { sequelize } = require('../config/database');

const tableExists = async (name) => {
  try {
    const [rows] = await sequelize.query('SHOW TABLES LIKE :name', {
      replacements: { name },
    });
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

const migrate = async () => {
  const summary = { changes: [] };
  if (!(await tableExists('pwa_properties'))) {
    return summary;
  }

  // 1) Drop NOT NULL on pwa_properties.auditorId so owners can self-onboard.
  const auditorIdCol = await describeColumn('pwa_properties', 'auditorId');
  if (auditorIdCol && auditorIdCol.Null === 'NO') {
    try {
      await sequelize.query(
        'ALTER TABLE `pwa_properties` MODIFY COLUMN `auditorId` INT NULL',
      );
      summary.changes.push('pwa_properties.auditorId -> NULL');
    } catch (err) {
      summary.changes.push(`pwa_properties.auditorId alter failed: ${err.message}`);
    }
  }

  // 2) Ensure the `source` enum column exists with the expected values.
  //    Older databases predate this column entirely.
  const sourceCol = await describeColumn('pwa_properties', 'source');
  if (!sourceCol) {
    try {
      await sequelize.query(
        "ALTER TABLE `pwa_properties` ADD COLUMN `source` ENUM('auditor','self') NOT NULL DEFAULT 'auditor'",
      );
      summary.changes.push('pwa_properties.source column added');
    } catch (err) {
      summary.changes.push(`pwa_properties.source add failed: ${err.message}`);
    }
  }

  // 3) photoHistory JSON column on pwa_property_fields (also added later,
  //    sometimes missed by alter sync).
  if (await tableExists('pwa_property_fields')) {
    const historyCol = await describeColumn('pwa_property_fields', 'photoHistory');
    if (!historyCol) {
      try {
        await sequelize.query(
          'ALTER TABLE `pwa_property_fields` ADD COLUMN `photoHistory` JSON NULL',
        );
        summary.changes.push('pwa_property_fields.photoHistory column added');
      } catch (err) {
        summary.changes.push(`pwa_property_fields.photoHistory add failed: ${err.message}`);
      }
    }

    // 4) deepDiveData JSON column — holds the structured fields formerly
    //    captured in Phase 4 + the per-room records for the rooms section.
    const deepCol = await describeColumn('pwa_property_fields', 'deepDiveData');
    if (!deepCol) {
      try {
        await sequelize.query(
          'ALTER TABLE `pwa_property_fields` ADD COLUMN `deepDiveData` JSON NULL',
        );
        summary.changes.push('pwa_property_fields.deepDiveData column added');
      } catch (err) {
        summary.changes.push(`pwa_property_fields.deepDiveData add failed: ${err.message}`);
      }
    }
  }

  // 5) Contract handoff columns used by the officer -> auditor/owner final
  //    signature flow. Production runs without alter sync, so add explicitly.
  if (await tableExists('pwa_contracts')) {
    const columns = [
      ['finalPdfUrl', 'VARCHAR(500) NULL'],
      ['finalOriginalName', 'VARCHAR(255) NULL'],
      ['finalMimeType', 'VARCHAR(120) NULL'],
      ['finalSignedAt', 'DATETIME NULL'],
      ['finalSignedByOfficerId', 'INT NULL'],
      ['finalSentToAuditorAt', 'DATETIME NULL'],
    ];
    for (const [column, definition] of columns) {
      const existing = await describeColumn('pwa_contracts', column);
      if (!existing) {
        try {
          await sequelize.query(
            `ALTER TABLE \`pwa_contracts\` ADD COLUMN \`${column}\` ${definition}`,
          );
          summary.changes.push(`pwa_contracts.${column} column added`);
        } catch (err) {
          summary.changes.push(`pwa_contracts.${column} add failed: ${err.message}`);
        }
      }
    }
  }

  return summary;
};

module.exports = { migrate };

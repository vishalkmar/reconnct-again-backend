// One-time migration: copy rows from the legacy `package_reviews` table into
// the unified polymorphic `reviews` table. Runs idempotently on every server
// boot — if there is nothing to migrate, it is a no-op. The legacy table is
// left in place so admins can verify the migration before we drop it later.
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

const countRows = async (name) => {
  try {
    const [rows] = await sequelize.query(`SELECT COUNT(*) AS c FROM \`${name}\``);
    return parseInt(rows[0]?.c || 0, 10);
  } catch {
    return 0;
  }
};

const migrate = async () => {
  const hasLegacy = await tableExists('package_reviews');
  const hasUnified = await tableExists('reviews');
  if (!hasLegacy || !hasUnified) return { copied: 0, skipped: 'tables missing' };

  // Don't overwrite if the unified table already has package rows — assume the
  // migration already happened. (We still leave fresh rows from new entity
  // types alone.)
  const [packageRows] = await sequelize.query(
    "SELECT COUNT(*) AS c FROM reviews WHERE entityType = 'package'"
  );
  if (parseInt(packageRows[0]?.c || 0, 10) > 0) {
    return { copied: 0, skipped: 'already migrated' };
  }

  const legacyCount = await countRows('package_reviews');
  if (legacyCount === 0) return { copied: 0, skipped: 'legacy table empty' };

  await sequelize.query(`
    INSERT INTO reviews
      (entityType, entityId, name, email, rating, title, comment, avatarUrl, isApproved, createdAt, updatedAt)
    SELECT
      'package', packageId, name, email, rating, title, comment, avatarUrl, isApproved, createdAt, updatedAt
    FROM package_reviews
  `);

  return { copied: legacyCount };
};

module.exports = { migrate };

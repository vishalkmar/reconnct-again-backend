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

  // bookings.itemType ENUM had the exact same missing-'experience' bug as
  // wishlist_items below — every experience booking (this app's ONLY real
  // booking target) silently coerced to itemType='' on save. That broke every
  // query filtering on itemType==='experience': the host's per-listing
  // bookings feed, the host dashboard stats, and the notifications feed all
  // silently saw zero bookings even though real, paid bookings existed.
  if (await tableExists('bookings')) {
    const col = await describeColumn('bookings', 'itemType');
    if (col && !/experience/i.test(col.Type || '')) {
      try {
        await sequelize.query(
          "ALTER TABLE `bookings` MODIFY COLUMN `itemType` ENUM('package','room','event','addon','event_activity','experience') NOT NULL",
        );
        summary.changes.push("bookings.itemType ENUM +experience");
      } catch (err) {
        summary.changes.push(`bookings.itemType alter failed: ${err.message}`);
      }
    }
    try {
      const [res] = await sequelize.query(
        "UPDATE `bookings` SET `itemType` = 'experience' WHERE (`itemType` = '' OR `itemType` IS NULL) AND JSON_UNQUOTE(JSON_EXTRACT(`itemSnapshot`, '$.type')) = 'experience'",
      );
      const fixed = res && (res.affectedRows != null ? res.affectedRows : 0);
      if (fixed) summary.changes.push(`bookings backfilled ${fixed} empty-itemType row(s) to 'experience'`);
    } catch (err) {
      summary.changes.push(`bookings itemType backfill failed: ${err.message}`);
    }
  }

  // 12h/2h-before booking reminders need a real comparable instant, not the
  // date-only scheduledFor.
  await addColumnIfMissing('bookings', 'scheduledAt', 'DATETIME NULL', summary);
  await addColumnIfMissing('bookings', 'reminder12hSentAt', 'DATETIME NULL', summary);
  await addColumnIfMissing('bookings', 'reminder2hSentAt', 'DATETIME NULL', summary);

  // Backfill scheduledAt for existing confirmed bookings that predate the
  // column, so the reminder sweep can pick them up too (harmless no-op for
  // ones already in the past).
  if (await tableExists('bookings')) {
    try {
      const { Booking } = require('../models');
      const { resolveScheduledAt } = require('../services/booking.service');
      const rows = await Booking.findAll({
        where: { status: 'confirmed', scheduledAt: null },
        attributes: ['id', 'scheduledFor', 'specialRequests'],
      });
      let filled = 0;
      for (const row of rows) {
        const at = resolveScheduledAt(row.scheduledFor, row.specialRequests);
        if (at) {
          // eslint-disable-next-line no-await-in-loop
          await row.update({ scheduledAt: at });
          filled += 1;
        }
      }
      if (filled) summary.changes.push(`bookings backfilled scheduledAt for ${filled} row(s)`);
    } catch (err) {
      summary.changes.push(`bookings scheduledAt backfill failed: ${err.message}`);
    }
  }

  // wishlist_items.entityType ENUM was missing 'experience', so MySQL coerced
  // experience saves to '' (empty). Widen the ENUM, then delete the malformed
  // empty-type rows so users can re-save experiences cleanly.
  if (await tableExists('wishlist_items')) {
    const col = await describeColumn('wishlist_items', 'entityType');
    if (col && !/experience/i.test(col.Type || '')) {
      try {
        await sequelize.query(
          "ALTER TABLE `wishlist_items` MODIFY COLUMN `entityType` ENUM('package','room','event','addon','experience') NOT NULL",
        );
        summary.changes.push('wishlist_items.entityType ENUM +experience');
      } catch (err) {
        summary.changes.push(`wishlist_items.entityType alter failed: ${err.message}`);
      }
    }
    try {
      const [res] = await sequelize.query("DELETE FROM `wishlist_items` WHERE `entityType` = '' OR `entityType` IS NULL");
      const removed = res && (res.affectedRows != null ? res.affectedRows : 0);
      if (removed) summary.changes.push(`wishlist_items pruned ${removed} malformed empty-type row(s)`);
    } catch (err) {
      summary.changes.push(`wishlist_items cleanup failed: ${err.message}`);
    }
  }
  return summary;
};

module.exports = { migrate };

const { sequelize } = require('../config/database');

/*
  Adds every NEW COLUMN introduced on EXISTING tables by the pricing-setup,
  payment-fraud and admin-2FA work.

  Why this is needed: in production the server runs `sequelize.sync({})` (no
  alter), which creates missing TABLES (markup_rules, fraud_events, …) but does
  NOT add new columns to tables that already exist. So without this migration a
  deployed build throws "Unknown column 'twoFactorEmail'…" etc. Idempotent —
  safe to run on every boot.

  New tables (markup_rules / gst_rules / convenience_rules / fraud_events /
  fraud_blocked_emails) are handled by sync itself and are not listed here.
*/

const tableExists = async (name) => {
  try {
    const [rows] = await sequelize.query('SHOW TABLES LIKE :name', { replacements: { name } });
    return rows.length > 0;
  } catch { return false; }
};

const columnExists = async (table, column) => {
  try {
    const [rows] = await sequelize.query(`SHOW COLUMNS FROM \`${table}\` LIKE :column`, { replacements: { column } });
    return !!rows[0];
  } catch { return false; }
};

const addColumnIfMissing = async (table, column, definition, changes) => {
  if (!(await tableExists(table))) return;
  if (await columnExists(table, column)) return;
  try {
    await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    changes.push(`${table}.${column} added`);
  } catch (err) {
    changes.push(`${table}.${column} add failed: ${err.message}`);
  }
};

const migrate = async () => {
  const changes = [];

  // ── Pricing Setup ──────────────────────────────────────────────────────
  // GST & Taxes: how GST was decided at go-live (included/double/pure/global).
  await addColumnIfMissing('experiences', 'gstConfig', 'JSON NULL', changes);
  // Convenience fee actually charged on a booking (paise).
  await addColumnIfMissing('bookings', 'conveniencePaise', 'INT NULL DEFAULT 0', changes);
  // Discount Management turns coupons into scoped rules.
  await addColumnIfMissing('coupons', 'scope', "ENUM('all','category','audience','experience') NOT NULL DEFAULT 'all'", changes);
  await addColumnIfMissing('coupons', 'targetIds', 'JSON NULL', changes);
  await addColumnIfMissing('coupons', 'isDiscountRule', 'TINYINT(1) NOT NULL DEFAULT 0', changes);
  await addColumnIfMissing('coupons', 'createdByAdminId', 'INT NULL', changes);
  await addColumnIfMissing('coupons', 'createdByName', 'VARCHAR(160) NULL', changes);

  // ── Payment fraud detection ────────────────────────────────────────────
  // The user's real IP/device captured at booking time (fraud attribution).
  await addColumnIfMissing('bookings', 'clientContext', 'JSON NULL', changes);

  // ── Address / geocoding ────────────────────────────────────────────────
  // State completes the address so it geocodes to an exact point (not city centre).
  await addColumnIfMissing('experiences', 'state', 'VARCHAR(120) NULL', changes);

  // ── Admin two-factor / MFA ─────────────────────────────────────────────
  await addColumnIfMissing('admins', 'twoFactorEmailEnabled', 'TINYINT(1) NOT NULL DEFAULT 0', changes);
  await addColumnIfMissing('admins', 'twoFactorEmail', 'VARCHAR(180) NULL', changes);
  await addColumnIfMissing('admins', 'totpEnabled', 'TINYINT(1) NOT NULL DEFAULT 0', changes);
  await addColumnIfMissing('admins', 'totpSecret', 'VARCHAR(255) NULL', changes);
  await addColumnIfMissing('admins', 'totpPendingSecret', 'VARCHAR(255) NULL', changes);
  await addColumnIfMissing('admins', 'twoFactorOtpHash', 'VARCHAR(255) NULL', changes);
  await addColumnIfMissing('admins', 'twoFactorOtpExpires', 'DATETIME NULL', changes);
  await addColumnIfMissing('admins', 'twoFactorOtpAttempts', 'INT NOT NULL DEFAULT 0', changes);

  return { changes };
};

module.exports = { migrate };

// Allow running directly: `node src/scripts/migratePricingAndSecuritySchema.js`
if (require.main === module) {
  (async () => {
    const { changes } = await migrate();
    console.log(changes.length ? changes.join('\n') : 'Nothing to migrate — all columns present.');
    process.exit(0);
  })();
}

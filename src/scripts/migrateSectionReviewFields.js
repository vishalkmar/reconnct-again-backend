const { sequelize } = require('../config/database');

/*
  Granular (section-by-section) Center Ops review — new columns on experiences:
    - reviewSections (JSON)     — per-section decisions:
        { [key]: { decision:'approved'|'objection', objection, at, by } }
    - reviewSuggestion (TEXT)   — COPS's optional overall suggestion for the round.
    - reviewRound (INT)         — how many follow-up cycles have run (0 = first pass).
    - reviewStage (VARCHAR)     — where the item sits in the granular pipeline:
        null/'submitted' (fresh), 'in_review' (COPS opened it),
        'follow_up' (sent back to submitter), 'resubmitted' (submitter sent it
        back after fixing) — lets the queue split "New" vs "Follow-up".
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
  await addColumnIfMissing('experiences', 'reviewSections', 'JSON NULL', changes);
  await addColumnIfMissing('experiences', 'reviewSuggestion', 'TEXT NULL', changes);
  await addColumnIfMissing('experiences', 'reviewRound', 'INT NOT NULL DEFAULT 0', changes);
  await addColumnIfMissing('experiences', 'reviewStage', 'VARCHAR(24) NULL', changes);
  // Snapshot of section content at the last follow-up (baseline for the diff),
  // and the submitter's per-objection resolution notes for the current round.
  await addColumnIfMissing('experiences', 'reviewSnapshot', 'JSON NULL', changes);
  await addColumnIfMissing('experiences', 'reviewResolutions', 'JSON NULL', changes);
  // Persistent per-section objection⇄resolution history across every round.
  await addColumnIfMissing('experiences', 'reviewThread', 'JSON NULL', changes);
  // The QCOPS physical-visit + feedback lifecycle (see utils/qcFeedback).
  await addColumnIfMissing('experiences', 'qcReview', 'JSON NULL', changes);
  return { changes };
};

module.exports = { migrate };

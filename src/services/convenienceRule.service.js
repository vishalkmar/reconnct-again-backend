const { Op } = require('sequelize');
const { ConvenienceRule, Experience } = require('../models');

/*
  Resolves the GLOBAL convenience fee (Pricing Setup → Convenience Management)
  down to the config one experience charges, and keeps `experience.convenienceFee`
  in sync with it.

  Identical engine to markupRule.service.js — four scopes, LATEST APPLIED WINS.
  The difference is purely where the fee lands in the price:

      base → +markup → −discount → +GST → +CONVENIENCE FEE → payable

  Everything downstream already reads `experience.convenienceFee`, so
  materialising the resolved rule onto that column means the booking engine, the
  app's breakdown and the go-live preview all pick it up unchanged.
*/

const asArr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const ids = (v) => asArr(v).map((x) => Number(x)).filter((x) => !Number.isNaN(x));

const matches = (rule, exp) => {
  const targets = ids(rule.targetIds);
  switch (rule.scope) {
    case 'all':
      return true;
    case 'category': {
      const own = new Set(ids(exp.categoryIds));
      if (exp.categoryId != null) own.add(Number(exp.categoryId));
      return targets.some((id) => own.has(id));
    }
    case 'audience': {
      const own = new Set(ids(exp.audiences));
      return targets.some((id) => own.has(id));
    }
    case 'experience':
      return targets.includes(Number(exp.id));
    default:
      return false;
  }
};

const stampOf = (r) => new Date(r.appliedAt || r.updatedAt || r.createdAt || 0).getTime();

const pickRule = (rules, exp) => {
  let best = null;
  for (const r of rules) {
    if (r.isActive === false) continue;
    if (!matches(r, exp)) continue;
    if (!best) { best = r; continue; }
    const a = stampOf(r); const b = stampOf(best);
    if (a > b || (a === b && r.id > best.id)) best = r;
  }
  return best;
};

// The shape written to `experience.convenienceFee` — type/value/months/cutThrough
// are what the pricing math and the app read; the rest is provenance for the UI.
const feeOf = (rule) => (rule
  ? {
    type: rule.type,
    value: num(rule.value),
    months: Number(rule.months) || 0,
    cutThrough: num(rule.cutThrough),
    ruleId: rule.id,
    scope: rule.scope,
    source: 'rule',
    note: rule.note || null,
    appliedAt: rule.appliedAt,
  }
  : null);

const loadRules = async () => ConvenienceRule.findAll({ where: { isActive: true }, order: [['appliedAt', 'ASC'], ['id', 'ASC']] });

const resolveForExperience = async (exp, rules) => {
  const rs = rules || (await loadRules());
  return feeOf(pickRule(rs, exp));
};

/*
  Set `item.convenienceFee` from the rules WITHOUT saving — the caller is about
  to save anyway. Any fee the client sent is discarded: this is admin-managed.

  If the rules can't be read the existing fee is LEFT ALONE rather than wiped,
  so a transient DB problem can't silently stop a charge mid-flight.
*/
const applyRuleConvenience = async (item, rules) => {
  let resolved;
  try {
    resolved = await resolveForExperience(item, rules);
  } catch (err) {
    console.warn('[convenience] could not resolve rules, keeping existing fee:', err.message);
    return item.convenienceFee || null;
  }
  item.convenienceFee = resolved;
  return resolved;
};

const sameFee = (a, b) => {
  const norm = (f) => (f ? `${f.type}:${num(f.value)}:${Number(f.months) || 0}:${num(f.cutThrough)}` : '');
  return norm(a) === norm(b);
};

/*
  Recompute + persist `convenienceFee` for every non-archived experience (or
  just the given ids). Run after ANY rule change — "latest wins" is global, so a
  new or deleted rule can move an experience in either direction.
*/
const syncExperienceConvenience = async ({ experienceIds } = {}) => {
  const rules = await loadRules();
  const where = { status: { [Op.ne]: 'archived' } };
  if (Array.isArray(experienceIds) && experienceIds.length) where.id = { [Op.in]: experienceIds };
  const rows = await Experience.findAll({
    where,
    attributes: ['id', 'audiences', 'categoryId', 'categoryIds', 'convenienceFee'],
  });
  let updated = 0;
  for (const row of rows) {
    const next = feeOf(pickRule(rules, row));
    if (!sameFee(next, row.convenienceFee)) {
      // eslint-disable-next-line no-await-in-loop
      await row.update({ convenienceFee: next });
      updated += 1;
    }
  }
  return { scanned: rows.length, updated };
};

const matchingRules = (rules, exp) => rules
  .filter((r) => r.isActive !== false && matches(r, exp))
  .sort((a, b) => stampOf(b) - stampOf(a) || b.id - a.id);

module.exports = {
  matches,
  pickRule,
  feeOf,
  loadRules,
  resolveForExperience,
  applyRuleConvenience,
  syncExperienceConvenience,
  matchingRules,
};

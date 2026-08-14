const { Op } = require('sequelize');
const { MarkupRule, Experience } = require('../models');

/*
  Resolves the GLOBAL markup (Pricing Setup → Markup Management) down to a
  single per-experience value, and keeps `experience.markup` in sync with it.

  Everything downstream (booking price, public/app price, B2B analytics) already
  reads `experience.markup`, so materialising the resolved rule onto that column
  means NOTHING else has to change — the go-live modal just displays it instead
  of asking for it.

  Conflict rule (as specified): when several rules match one experience, THE
  LATEST APPLIED ONE WINS — broadest vs narrowest is irrelevant.
*/

const asArr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const ids = (v) => asArr(v).map((x) => Number(x)).filter((x) => !Number.isNaN(x));

// Does this rule cover this experience?
const matches = (rule, exp) => {
  const targets = ids(rule.targetIds);
  switch (rule.scope) {
    case 'all':
      return true;
    case 'category': {
      // categoryIds is the source of truth; categoryId is the legacy mirror.
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

// The winning rule for one experience — latest appliedAt, id as the tie-break.
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

// The shape written to `experience.markup`. `type`/`value` are all the pricing
// math reads (utils/goLivePricing); the rest is provenance for the UI.
const markupOf = (rule) => (rule
  ? {
    type: rule.type,
    value: num(rule.value),
    ruleId: rule.id,
    scope: rule.scope,
    source: 'rule',
    note: rule.note || null,
    appliedAt: rule.appliedAt,
  }
  : null);

const loadRules = async () => MarkupRule.findAll({ where: { isActive: true }, order: [['appliedAt', 'ASC'], ['id', 'ASC']] });

// Resolve one experience against a (pre-loaded, or freshly fetched) rule set.
const resolveForExperience = async (exp, rules) => {
  const rs = rules || (await loadRules());
  return markupOf(pickRule(rs, exp));
};

/*
  Set `item.markup` from the rules WITHOUT saving — the caller is already about
  to save (go-live publish, experience create). Any markup the client sent is
  discarded: markup is admin-managed only.

  If the rules can't be read at all (e.g. the table hasn't been created yet on a
  fresh deploy) the existing markup is LEFT ALONE rather than wiped — going live
  must never silently drop a price the platform is already charging.
*/
const applyRuleMarkup = async (item, rules) => {
  let resolved;
  try {
    resolved = await resolveForExperience(item, rules);
  } catch (err) {
    console.warn('[markup] could not resolve rules, keeping existing markup:', err.message);
    return item.markup || null;
  }
  item.markup = resolved;
  return resolved;
};

const sameMarkup = (a, b) => {
  const norm = (m) => (m && (m.value || m.type) ? `${m.type}:${num(m.value)}:${m.ruleId || ''}` : '');
  return norm(a) === norm(b);
};

/*
  Recompute + persist `markup` for every non-archived experience (or just the
  given ids). Run after ANY rule change — because "latest wins" is global, a new
  or deleted rule can move an experience in either direction, so a full pass is
  both the simplest and the only correct option at this data size.
*/
const syncExperienceMarkups = async ({ experienceIds } = {}) => {
  const rules = await loadRules();
  const where = { status: { [Op.ne]: 'archived' } };
  if (Array.isArray(experienceIds) && experienceIds.length) where.id = { [Op.in]: experienceIds };
  const rows = await Experience.findAll({
    where,
    attributes: ['id', 'audiences', 'categoryId', 'categoryIds', 'markup'],
  });
  let updated = 0;
  for (const row of rows) {
    const next = markupOf(pickRule(rules, row));
    if (!sameMarkup(next, row.markup)) {
      // eslint-disable-next-line no-await-in-loop
      await row.update({ markup: next });
      updated += 1;
    }
  }
  return { scanned: rows.length, updated };
};

// Every rule that matches an experience, newest first — powers the "why is my
// markup this?" trail in the go-live modal + the management page.
const matchingRules = (rules, exp) => rules
  .filter((r) => r.isActive !== false && matches(r, exp))
  .sort((a, b) => stampOf(b) - stampOf(a) || b.id - a.id);

module.exports = {
  matches,
  pickRule,
  markupOf,
  loadRules,
  resolveForExperience,
  applyRuleMarkup,
  syncExperienceMarkups,
  matchingRules,
};

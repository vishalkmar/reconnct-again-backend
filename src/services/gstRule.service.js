const { Op } = require('sequelize');
const { GstRule, Experience } = require('../models');

/*
  Resolves the GLOBAL GST (Pricing Setup → GST & Taxes Management) down to the
  single rate an experience charges, and keeps `experience.gstRate` in sync.

  Two inputs decide the outcome:

  1. THE ADDER'S TOGGLE — every upload form (admin / BD / host / supplier, web
     and app) has an "Included GST" switch on the B2B price. When it's on, the
     quoted price ALREADY contains GST at `pricing.gstIncludedRate`.
  2. CENTER OPS'S GO-LIVE DECISION (`experience.gstConfig.mode`):
        global    → adder quoted GST-exclusive: our resolved rate applies (default)
        included  → adder's price already has GST: we add NOTHING (default when
                    the toggle was on)
        double    → keep their GST in the price AND add ours on top
        pure      → strip their GST out of the base, then apply only ours

  `pure` needs the base to be de-grossed before tax, which is what
  utils/goLivePricing.taxableBase() does for the booking + preview math.

  Conflict rule, identical to markup: when several rules match one experience,
  THE LATEST APPLIED ONE WINS.
*/

const asArr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const ids = (v) => asArr(v).map((x) => Number(x)).filter((x) => !Number.isNaN(x));

const MODES = ['global', 'included', 'double', 'pure'];

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

const loadRules = async () => GstRule.findAll({ where: { isActive: true }, order: [['appliedAt', 'ASC'], ['id', 'ASC']] });

// What the adder quoted: did their B2B price already include GST, and at what rate?
const submittedGst = (exp) => {
  const p = (exp && exp.pricing) || {};
  return {
    included: !!p.gstIncluded,
    rate: num(p.gstIncludedRate),
  };
};

/*
  The full GST picture for one experience:
    { mode, rate, ruleRate, submittedIncluded, submittedRate, ruleId, ruleScope }
  `rate` is what we actually charge (0 in 'included' mode).
*/
const resolveGst = (exp, rules) => {
  const sub = submittedGst(exp);
  const rule = pickRule(rules, exp);
  const ruleRate = rule ? num(rule.rate) : 0;

  /*
    `decidedMode` is the ONLY sticky field — it is written when a human actually
    chooses on the go-live screen, and nowhere else. `mode` below is derived and
    re-derived on every sync; storing the derived value under its own key would
    freeze it (a listing that later gets flagged GST-inclusive would stay
    'global' forever), which is exactly the trap this split avoids.

    With no decision on file: a GST-inclusive price defaults to 'included' —
    charge nothing extra — so we never silently double-tax a customer.
  */
  const decided = exp.gstConfig && MODES.includes(exp.gstConfig.decidedMode) ? exp.gstConfig.decidedMode : null;
  const mode = decided || (sub.included ? 'included' : 'global');

  const rate = mode === 'included' ? 0 : ruleRate;

  return {
    mode,
    rate,
    ruleRate,
    submittedIncluded: sub.included,
    submittedRate: sub.rate,
    ruleId: rule ? rule.id : null,
    ruleScope: rule ? rule.scope : null,
    source: rule && rule.scope === 'experience' ? 'manual' : 'rule',
    // Echoed back so the UI can tell "COPS chose this" from "this is the default".
    decidedMode: decided,
    decidedAt: (exp.gstConfig && exp.gstConfig.decidedAt) || null,
  };
};

/*
  Write the resolved GST onto the item WITHOUT saving. `body.gstMode` lets a
  go-live caller record Center Ops's decision in the same pass.

  If the rules can't be read at all the existing rate is LEFT ALONE rather than
  zeroed — going live must never silently stop charging tax.
*/
const applyRuleGst = async (item, body = {}, rules) => {
  let rs;
  try {
    rs = rules || (await loadRules());
  } catch (err) {
    console.warn('[gst] could not resolve rules, keeping existing rate:', err.message);
    return { mode: (item.gstConfig && item.gstConfig.mode) || 'global', rate: num(item.gstRate) };
  }
  // A go-live decision arriving on the request wins over whatever was stored.
  if (body && MODES.includes(body.gstMode)) {
    item.gstConfig = { ...(item.gstConfig || {}), decidedMode: body.gstMode, decidedAt: new Date() };
  }
  const prev = item.gstConfig || {};
  const resolved = resolveGst(item, rs);
  item.gstRate = Math.round(resolved.rate);
  item.gstConfig = { ...resolved, decidedMode: prev.decidedMode || null, decidedAt: prev.decidedAt || null };
  return resolved;
};

const sameGst = (a, b) => `${num(a && a.rate)}:${(a && a.mode) || ''}` === `${num(b && b.rate)}:${(b && b.mode) || ''}`;

/*
  Recompute + persist gstRate/gstConfig for every non-archived experience (or
  just the given ids). Run after ANY rule change — "latest wins" is global, so a
  new or deleted rule can move any experience in either direction.

  Center Ops's per-experience MODE decision is preserved; only the rate moves.
*/
const syncExperienceGst = async ({ experienceIds } = {}) => {
  const rules = await loadRules();
  const where = { status: { [Op.ne]: 'archived' } };
  if (Array.isArray(experienceIds) && experienceIds.length) where.id = { [Op.in]: experienceIds };
  const rows = await Experience.findAll({
    where,
    attributes: ['id', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'gstRate', 'gstConfig'],
  });
  let updated = 0;
  for (const row of rows) {
    const next = resolveGst(row, rules);
    const prev = row.gstConfig || {};
    const cur = { rate: num(row.gstRate), mode: prev.mode || null };
    if (!sameGst(next, cur)) {
      // eslint-disable-next-line no-await-in-loop
      await row.update({
        gstRate: Math.round(next.rate),
        // decidedMode/decidedAt are a human's choice — a resync never touches them.
        gstConfig: { ...next, decidedMode: prev.decidedMode || null, decidedAt: prev.decidedAt || null },
      });
      updated += 1;
    }
  }
  return { scanned: rows.length, updated };
};

const matchingRules = (rules, exp) => rules
  .filter((r) => r.isActive !== false && matches(r, exp))
  .sort((a, b) => stampOf(b) - stampOf(a) || b.id - a.id);

module.exports = {
  MODES,
  matches,
  pickRule,
  loadRules,
  submittedGst,
  resolveGst,
  applyRuleGst,
  syncExperienceGst,
  matchingRules,
};

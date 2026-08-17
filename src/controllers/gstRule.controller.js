const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  GstRule, Experience, ExperienceCategory, ExperienceAudience,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const {
  MODES, loadRules, pickRule, matches, matchingRules, resolveGst, syncExperienceGst,
} = require('../services/gstRule.service');
const { taxableBase, withMarkup } = require('../utils/goLivePricing');

/*
  Admin "Pricing Setup Management → GST & Taxes Management".

  Mirrors Markup Management: rules by scope, latest-applied wins, and the
  go-live screen only displays the result. The extra piece GST has is the
  adder's "Included GST" toggle — when a submitted price already carries tax,
  Center Ops picks how ours interacts with it (included / double / pure), and
  that decision lives on the experience, not on a rule.
*/

const SCOPES = ['all', 'category', 'audience', 'experience'];
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const loadExperiences = async () => Experience.findAll({
  where: { status: { [Op.ne]: 'archived' } },
  attributes: ['id', 'name', 'city', 'location', 'mainImage', 'status', 'isActive',
    'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup', 'gstRate', 'gstConfig'],
  order: [['name', 'ASC']],
});

const isLive = (e) => e.status === 'published' && e.isActive !== false;
const basePriceOf = (e) => num(e.pricing?.adultPrice || e.pricing?.fromPrice);

const labelTargets = async (rules) => {
  const catIds = new Set(); const audIds = new Set(); const expIds = new Set();
  rules.forEach((r) => {
    const t = Array.isArray(r.targetIds) ? r.targetIds.map(Number) : [];
    if (r.scope === 'category') t.forEach((i) => catIds.add(i));
    if (r.scope === 'audience') t.forEach((i) => audIds.add(i));
    if (r.scope === 'experience') t.forEach((i) => expIds.add(i));
  });
  const [cats, auds, exps] = await Promise.all([
    catIds.size ? ExperienceCategory.findAll({ where: { id: [...catIds] }, attributes: ['id', 'name'] }) : [],
    audIds.size ? ExperienceAudience.findAll({ where: { id: [...audIds] }, attributes: ['id', 'name'] }) : [],
    expIds.size ? Experience.findAll({ where: { id: [...expIds] }, attributes: ['id', 'name'] }) : [],
  ]);
  const map = {
    category: new Map(cats.map((c) => [c.id, c.name])),
    audience: new Map(auds.map((a) => [a.id, a.name])),
    experience: new Map(exps.map((e) => [e.id, e.name])),
  };
  return (rule) => {
    if (rule.scope === 'all') return ['All experiences'];
    const t = Array.isArray(rule.targetIds) ? rule.targetIds.map(Number) : [];
    return t.map((id) => map[rule.scope]?.get(id) || `#${id}`);
  };
};

// The per-adult money trail for one experience, so the tables can show the real
// effect of each mode rather than just a percentage.
const breakdownFor = (e, g) => {
  const quoted = basePriceOf(e);
  const net = taxableBase(quoted, { gstConfig: g, pricing: e.pricing });
  const afterMarkup = withMarkup(net, e.markup);
  const gst = (afterMarkup * num(g.rate)) / 100;
  return {
    quotedBase: r2(quoted),
    taxableBase: r2(net),
    afterMarkup: r2(afterMarkup),
    gstAmount: r2(gst),
    payableBeforeExtras: r2(afterMarkup + gst),
  };
};

// ── GET /gst/rules ─────────────────────────────────────────────────────────
const listRules = asyncHandler(async (req, res) => {
  const [rules, exps] = await Promise.all([
    GstRule.findAll({ order: [['appliedAt', 'DESC'], ['id', 'DESC']] }),
    loadExperiences(),
  ]);
  const active = rules.filter((r) => r.isActive !== false);
  const winCount = new Map();
  const matchCount = new Map();
  exps.forEach((e) => {
    active.forEach((r) => { if (matches(r, e)) matchCount.set(r.id, (matchCount.get(r.id) || 0) + 1); });
    const win = pickRule(active, e);
    if (win) winCount.set(win.id, (winCount.get(win.id) || 0) + 1);
  });
  const label = await labelTargets(rules);
  const items = rules.map((r) => {
    const j = r.toJSON();
    return {
      ...j,
      rate: num(j.rate),
      targetNames: label(j),
      matchingExperiences: matchCount.get(j.id) || 0,
      effectiveOn: winCount.get(j.id) || 0,
    };
  });
  return ok(res, { items });
});

// ── GET /gst/targets ───────────────────────────────────────────────────────
const targets = asyncHandler(async (req, res) => {
  const [cats, auds, exps] = await Promise.all([
    ExperienceCategory.findAll({ where: { isActive: true }, attributes: ['id', 'name'], order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
    ExperienceAudience.findAll({ where: { isActive: true }, attributes: ['id', 'name'], order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
    loadExperiences(),
  ]);
  return ok(res, {
    categories: cats.map((c) => ({ id: c.id, name: c.name })),
    audiences: auds.map((a) => ({ id: a.id, name: a.name })),
    experiences: exps.filter(isLive).map((e) => ({
      id: e.id,
      name: e.name,
      city: e.city || e.location || '',
      basePrice: basePriceOf(e),
      gstIncluded: !!e.pricing?.gstIncluded,
    })),
  });
});

// ── GET /gst/effective ─────────────────────────────────────────────────────
// Every experience with the rate it currently charges + how that was decided.
const effectiveList = asyncHandler(async (req, res) => {
  const [rules, exps] = await Promise.all([loadRules(), loadExperiences()]);
  const label = await labelTargets(rules);
  const items = exps.map((e) => {
    const g = resolveGst(e, rules);
    const win = rules.find((r) => r.id === g.ruleId) || null;
    return {
      id: e.id,
      name: e.name,
      city: e.city || e.location || '',
      live: isLive(e),
      submittedIncluded: g.submittedIncluded,
      submittedRate: g.submittedRate,
      mode: g.mode,
      rate: g.rate,
      ruleRate: g.ruleRate,
      ruleLabel: win ? (win.scope === 'all' ? 'All experiences' : label(win).join(', ')) : null,
      ...breakdownFor(e, g),
    };
  });
  return ok(res, { items });
});

// ── GET /gst/experience/:experienceId ──────────────────────────────────────
// What the go-live screen reads: the resolved GST + everything it needs to
// render the "price already includes GST" warning and the Enable dialog.
const effectiveForExperience = asyncHandler(async (req, res) => {
  const exp = await Experience.findByPk(req.params.experienceId, {
    attributes: ['id', 'name', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup', 'gstRate', 'gstConfig'],
  });
  if (!exp) return fail(res, 'Experience not found', 404);
  const rules = await loadRules();
  const g = resolveGst(exp, rules);
  const label = await labelTargets(rules);
  const win = rules.find((r) => r.id === g.ruleId) || null;

  // Preview every mode so the dialog can show real numbers, not just labels.
  const preview = {};
  for (const mode of MODES) {
    const trial = { ...g, mode, rate: mode === 'included' ? 0 : g.ruleRate };
    preview[mode] = breakdownFor(exp, trial);
    preview[mode].rate = trial.rate;
  }

  return ok(res, {
    experienceId: exp.id,
    gst: g,
    rule: win ? { id: win.id, scope: win.scope, rate: num(win.rate), appliedAt: win.appliedAt, targetNames: label(win) } : null,
    otherRules: matchingRules(rules, exp)
      .filter((r) => !win || r.id !== win.id)
      .map((r) => ({ id: r.id, scope: r.scope, rate: num(r.rate), appliedAt: r.appliedAt, targetNames: label(r) })),
    preview,
  });
});

const validateRule = (body) => {
  const scope = String(body.scope || '').trim();
  if (!SCOPES.includes(scope)) return { error: 'Pick a valid scope' };
  const rate = num(body.rate);
  if (rate < 0 || rate > 100) return { error: 'GST must be between 0 and 100%' };
  let targetIds = [];
  if (scope !== 'all') {
    targetIds = (Array.isArray(body.targetIds) ? body.targetIds : []).map(Number).filter((n) => n > 0);
    if (!targetIds.length) return { error: 'Select at least one target' };
  }
  return { data: { scope, targetIds, rate, note: (body.note || '').trim() || null } };
};

const who = (req) => (req.admin ? (req.admin.name || req.admin.email) : (req.teamMember ? req.teamMember.name : null));

// ── POST /gst/rules ────────────────────────────────────────────────────────
const createRule = asyncHandler(async (req, res) => {
  const { error, data } = validateRule(req.body);
  if (error) return fail(res, error, 400);
  const rule = await GstRule.create({
    ...data,
    appliedAt: new Date(),
    createdByAdminId: req.admin ? req.admin.id : null,
    createdByName: who(req),
  });
  const sync = await syncExperienceGst();
  return created(res, { item: rule.toJSON(), sync }, `GST applied to ${sync.updated} experience(s)`);
});

// ── PUT /gst/rules/:id ─────────────────────────────────────────────────────
const updateRule = asyncHandler(async (req, res) => {
  const rule = await GstRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  const { error, data } = validateRule({ ...rule.toJSON(), ...req.body });
  if (error) return fail(res, error, 400);
  await rule.update({ ...data, appliedAt: new Date() });
  const sync = await syncExperienceGst();
  return ok(res, { item: rule.toJSON(), sync }, 'GST updated');
});

// ── PATCH /gst/rules/:id/toggle ────────────────────────────────────────────
const toggleRule = asyncHandler(async (req, res) => {
  const rule = await GstRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  await rule.update({ isActive: !rule.isActive });
  const sync = await syncExperienceGst();
  return ok(res, { item: rule.toJSON(), sync }, rule.isActive ? 'GST rule resumed' : 'GST rule paused');
});

// ── DELETE /gst/rules/:id ──────────────────────────────────────────────────
const removeRule = asyncHandler(async (req, res) => {
  const rule = await GstRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  await rule.destroy();
  const sync = await syncExperienceGst();
  return ok(res, { sync }, 'GST rule removed');
});

/*
  ── PUT /gst/experience/:experienceId ────────────────────────────────────────
  The go-live screen's GST decision for ONE listing:
     { mode: 'included'|'double'|'pure'|'global', rate?: number }
  `mode` is stored on the experience. An explicit `rate` is stored as a
  scope:'experience' GST rule with a fresh appliedAt — same trick as markup, so
  a per-listing rate is visible in GST Management and survives every resync,
  while the global default is untouched.
*/
const setExperienceDecision = asyncHandler(async (req, res) => {
  const fromParam = req.params.experienceId ? [Number(req.params.experienceId)] : [];
  const fromBody = Array.isArray(req.body.experienceIds) ? req.body.experienceIds.map(Number) : [];
  const targetIds = [...new Set([...fromParam, ...fromBody])].filter((n) => n > 0);
  if (!targetIds.length) return fail(res, 'No experience given', 400);

  const mode = MODES.includes(req.body.mode) ? req.body.mode : null;
  const hasRate = req.body.rate !== undefined && req.body.rate !== null && req.body.rate !== '';
  const rate = num(req.body.rate);
  if (!mode && !hasRate) return fail(res, 'Nothing to change', 400);
  if (hasRate && (rate < 0 || rate > 100)) return fail(res, 'GST must be between 0 and 100%', 400);

  // A per-listing rate becomes (or updates) that listing's own GST rule.
  if (hasRate) {
    const existing = await GstRule.findAll({ where: { scope: 'experience' } });
    const now = new Date();
    for (const id of targetIds) {
      const own = existing.find((r) => {
        const t = Array.isArray(r.targetIds) ? r.targetIds.map(Number) : [];
        return t.length === 1 && t[0] === id;
      });
      // eslint-disable-next-line no-await-in-loop
      if (own) await own.update({ rate, isActive: true, appliedAt: now });
      // eslint-disable-next-line no-await-in-loop
      else await GstRule.create({
        scope: 'experience',
        targetIds: [id],
        rate,
        note: 'Set from the go-live pricing screen',
        appliedAt: now,
        createdByAdminId: req.admin ? req.admin.id : null,
        createdByName: who(req),
      });
    }
  }

  // The mode lives on each experience.
  if (mode) {
    const rows = await Experience.findAll({ where: { id: { [Op.in]: targetIds } } });
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await row.update({ gstConfig: { ...(row.gstConfig || {}), decidedMode: mode, decidedAt: new Date() } });
    }
  }

  await syncExperienceGst({ experienceIds: targetIds });

  const rules = await loadRules();
  const exp = await Experience.findByPk(targetIds[0], {
    attributes: ['id', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup', 'gstRate', 'gstConfig'],
  });
  return ok(res, { gst: resolveGst(exp, rules) }, 'GST set for this experience');
});

// ── DELETE /gst/experience/:experienceId ───────────────────────────────────
// Drop the per-listing rate override AND the mode decision — back to global.
const clearExperienceDecision = asyncHandler(async (req, res) => {
  const id = Number(req.params.experienceId);
  const exp = await Experience.findByPk(id);
  if (!exp) return fail(res, 'Experience not found', 404);

  const own = (await GstRule.findAll({ where: { scope: 'experience' } })).filter((r) => {
    const t = Array.isArray(r.targetIds) ? r.targetIds.map(Number) : [];
    return t.length === 1 && t[0] === id;
  });
  for (const r of own) {
    // eslint-disable-next-line no-await-in-loop
    await r.destroy();
  }
  await exp.update({ gstConfig: { ...(exp.gstConfig || {}), decidedMode: null, decidedAt: null } });
  await syncExperienceGst({ experienceIds: [id] });

  const rules = await loadRules();
  const fresh = await Experience.findByPk(id, {
    attributes: ['id', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup', 'gstRate', 'gstConfig'],
  });
  return ok(res, { gst: resolveGst(fresh, rules) }, 'Back to the global GST');
});

// ── POST /gst/resync ───────────────────────────────────────────────────────
const resync = asyncHandler(async (req, res) => {
  const sync = await syncExperienceGst();
  return ok(res, { sync }, `GST re-applied — ${sync.updated} experience(s) updated`);
});

module.exports = {
  listRules,
  targets,
  effectiveList,
  effectiveForExperience,
  createRule,
  updateRule,
  toggleRule,
  removeRule,
  setExperienceDecision,
  clearExperienceDecision,
  resync,
};

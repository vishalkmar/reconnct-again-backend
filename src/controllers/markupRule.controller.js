const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  MarkupRule, Experience, ExperienceCategory, ExperienceAudience,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const {
  loadRules, pickRule, markupOf, matches, matchingRules, syncExperienceMarkups,
} = require('../services/markupRule.service');
const { findGlobalRules, collapseGlobalRules } = require('../utils/singleGlobalRule');

/*
  Admin "Pricing Setup Management → Markup Management".

  Markup is set ONCE here, globally, and flows down to every matching
  experience automatically (see services/markupRule.service.js). The go-live
  pricing modal only displays it; its Edit button posts a per-experience
  override, which is stored as one more rule so the same "latest wins" rule
  decides the outcome.
*/

const SCOPES = ['all', 'category', 'audience', 'experience'];
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

// Non-archived experiences, with just what the matcher + labels need.
const loadExperiences = async () => Experience.findAll({
  where: { status: { [Op.ne]: 'archived' } },
  attributes: ['id', 'name', 'city', 'location', 'mainImage', 'status', 'isActive', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup'],
  order: [['name', 'ASC']],
});

const isLive = (e) => e.status === 'published' && e.isActive !== false;
const basePriceOf = (e) => num(e.pricing?.adultPrice || e.pricing?.fromPrice);

const markupAmountFor = (base, m) => {
  if (!m || !m.value) return 0;
  return m.type === 'fixed' ? num(m.value) : (num(base) * num(m.value)) / 100;
};

// Human labels for a rule's targets (category / audience / experience names).
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

// ── GET /markup/rules ──────────────────────────────────────────────────────
// Every rule + how many experiences it currently WINS on (not just matches),
// so the table shows the real effect of the "latest wins" ordering.
const listRules = asyncHandler(async (req, res) => {
  const [rules, exps] = await Promise.all([
    MarkupRule.findAll({ order: [['appliedAt', 'DESC'], ['id', 'DESC']] }),
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
      value: num(j.value),
      targetNames: label(j),
      matchingExperiences: matchCount.get(j.id) || 0,
      effectiveOn: winCount.get(j.id) || 0,
    };
  });
  return ok(res, { items });
});

// ── GET /markup/targets ────────────────────────────────────────────────────
// Everything the "add a markup" form's multi-selects need.
const targets = asyncHandler(async (req, res) => {
  const [cats, auds, exps] = await Promise.all([
    ExperienceCategory.findAll({ where: { isActive: true }, attributes: ['id', 'name', 'audiences'], order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
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
      image: e.mainImage,
      basePrice: basePriceOf(e),
    })),
  });
});

// ── GET /markup/effective ──────────────────────────────────────────────────
// Every non-archived experience with the markup that currently wins on it —
// the "who ends up with what" table on the management page.
const effectiveList = asyncHandler(async (req, res) => {
  const [rules, exps] = await Promise.all([loadRules(), loadExperiences()]);
  const label = await labelTargets(rules);
  const items = exps.map((e) => {
    const win = pickRule(rules, e);
    const m = markupOf(win);
    const base = basePriceOf(e);
    const amount = markupAmountFor(base, m);
    return {
      id: e.id,
      name: e.name,
      city: e.city || e.location || '',
      image: e.mainImage,
      live: isLive(e),
      basePrice: base,
      markup: m,
      markupAmount: Math.round(amount * 100) / 100,
      finalBase: Math.round((base + amount) * 100) / 100,
      ruleLabel: win ? `${win.scope === 'all' ? 'All experiences' : label(win).join(', ')}` : null,
    };
  });
  return ok(res, { items });
});

// ── GET /markup/effective/:experienceId ────────────────────────────────────
// The single resolved markup for one experience — what the go-live modal shows
// in place of the (now disabled) markup inputs.
const effectiveForExperience = asyncHandler(async (req, res) => {
  const exp = await Experience.findByPk(req.params.experienceId, {
    attributes: ['id', 'name', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup'],
  });
  if (!exp) return fail(res, 'Experience not found', 404);
  const rules = await loadRules();
  const win = pickRule(rules, exp);
  const label = await labelTargets(rules);
  const all = matchingRules(rules, exp);
  return ok(res, {
    experienceId: exp.id,
    markup: markupOf(win),
    rule: win ? { ...win.toJSON(), value: num(win.value), targetNames: label(win) } : null,
    // Every rule that also matches — lets the modal explain why this one won.
    otherRules: all.filter((r) => !win || r.id !== win.id).map((r) => ({
      id: r.id, scope: r.scope, type: r.type, value: num(r.value), appliedAt: r.appliedAt, targetNames: label(r),
    })),
  });
});

const validateRule = (body) => {
  const scope = String(body.scope || '').trim();
  if (!SCOPES.includes(scope)) return { error: 'Pick a valid scope' };
  const type = body.type === 'fixed' ? 'fixed' : 'percentage';
  const value = num(body.value);
  if (value < 0) return { error: 'Markup cannot be negative' };
  if (type === 'percentage' && value > 100) return { error: 'A percentage markup cannot be above 100%' };
  if (value === 0) return { error: 'Enter a markup value' };
  let targetIds = [];
  if (scope !== 'all') {
    targetIds = (Array.isArray(body.targetIds) ? body.targetIds : []).map(Number).filter((n) => n > 0);
    if (!targetIds.length) return { error: 'Select at least one target' };
  }
  return { data: { scope, targetIds, type, value, note: (body.note || '').trim() || null } };
};

// ── POST /markup/rules ─────────────────────────────────────────────────────
const createRule = asyncHandler(async (req, res) => {
  const { error, data } = validateRule(req.body);
  if (error) return fail(res, error, 400);
  const stamp = {
    appliedAt: new Date(),
    createdByAdminId: req.admin ? req.admin.id : null,
    createdByName: req.admin ? (req.admin.name || req.admin.email) : (req.teamMember ? req.teamMember.name : null),
  };

  // "To All" is the single platform-wide default — a new one replaces the old
  // one rather than stacking a rule that would govern nothing.
  if (data.scope === 'all') {
    const existing = await findGlobalRules(MarkupRule);
    if (existing.length) {
      const keep = existing[0];
      await keep.update({ ...data, isActive: true, ...stamp });
      await collapseGlobalRules(MarkupRule, keep.id);
      const s = await syncExperienceMarkups();
      return ok(res, { item: keep.toJSON(), sync: s, replaced: true },
        `Platform-wide markup updated — applied to ${s.updated} experience(s)`);
    }
  }

  const rule = await MarkupRule.create({ ...data, ...stamp });
  const sync = await syncExperienceMarkups();
  return created(res, { item: rule.toJSON(), sync }, `Markup applied to ${sync.updated} experience(s)`);
});

// ── PUT /markup/rules/:id ──────────────────────────────────────────────────
// Editing bumps appliedAt — an edit IS the latest decision, so it wins again.
const updateRule = asyncHandler(async (req, res) => {
  const rule = await MarkupRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  const { error, data } = validateRule({ ...rule.toJSON(), ...req.body });
  if (error) return fail(res, error, 400);
  await rule.update({ ...data, appliedAt: new Date() });
  // Editing a rule INTO the 'all' scope must not create a second global default.
  if (data.scope === 'all') await collapseGlobalRules(MarkupRule, rule.id);
  const sync = await syncExperienceMarkups();
  return ok(res, { item: rule.toJSON(), sync }, 'Markup updated');
});

// ── PATCH /markup/rules/:id/toggle ─────────────────────────────────────────
// Pause / resume. Deliberately does NOT bump appliedAt, so resuming an old rule
// can't jump the queue ahead of newer ones.
const toggleRule = asyncHandler(async (req, res) => {
  const rule = await MarkupRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  await rule.update({ isActive: !rule.isActive });
  const sync = await syncExperienceMarkups();
  return ok(res, { item: rule.toJSON(), sync }, rule.isActive ? 'Markup resumed' : 'Markup paused');
});

// ── DELETE /markup/rules/:id ───────────────────────────────────────────────
const removeRule = asyncHandler(async (req, res) => {
  const rule = await MarkupRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  await rule.destroy();
  const sync = await syncExperienceMarkups();
  return ok(res, { sync }, 'Markup removed');
});

// ── PUT /markup/experience/:experienceId ───────────────────────────────────
/*
  The go-live modal's "Edit" — a one-off markup for a single experience. Stored
  as a scope:'experience' rule with a fresh appliedAt so it beats whatever
  category/audience/all rule was in force, under the same latest-wins logic.
  Re-editing the same experience updates that rule instead of piling up rows.
  Accepts several ids at once (direct-listing publishes N activities together).
*/
const setExperienceOverride = asyncHandler(async (req, res) => {
  const fromParam = req.params.experienceId ? [Number(req.params.experienceId)] : [];
  const fromBody = Array.isArray(req.body.experienceIds) ? req.body.experienceIds.map(Number) : [];
  const targetIds = [...new Set([...fromParam, ...fromBody])].filter((n) => n > 0);
  if (!targetIds.length) return fail(res, 'No experience given', 400);

  const { error, data } = validateRule({ ...req.body, scope: 'experience', targetIds });
  if (error) return fail(res, error, 400);

  const rules = await MarkupRule.findAll({ where: { scope: 'experience' } });
  const now = new Date();
  for (const id of targetIds) {
    // An existing override that targets ONLY this experience is reused; a
    // shared multi-target override is left alone and a fresh one written.
    const own = rules.find((r) => {
      const t = Array.isArray(r.targetIds) ? r.targetIds.map(Number) : [];
      return t.length === 1 && t[0] === id;
    });
    // eslint-disable-next-line no-await-in-loop
    if (own) await own.update({ type: data.type, value: data.value, note: data.note, isActive: true, appliedAt: now });
    // eslint-disable-next-line no-await-in-loop
    else await MarkupRule.create({
      scope: 'experience',
      targetIds: [id],
      type: data.type,
      value: data.value,
      note: data.note || 'Set from the go-live pricing screen',
      appliedAt: now,
      createdByAdminId: req.admin ? req.admin.id : null,
      createdByName: req.admin ? (req.admin.name || req.admin.email) : (req.teamMember ? req.teamMember.name : null),
    });
  }
  await syncExperienceMarkups();

  const fresh = await loadRules();
  const exp = await Experience.findByPk(targetIds[0], { attributes: ['id', 'audiences', 'categoryId', 'categoryIds'] });
  return ok(res, { markup: markupOf(pickRule(fresh, exp)) }, 'Markup set for this experience');
});

// ── DELETE /markup/experience/:experienceId ────────────────────────────────
// Drop the one-off override; the experience falls back to the broader rules.
const clearExperienceOverride = asyncHandler(async (req, res) => {
  const id = Number(req.params.experienceId);
  const rules = await MarkupRule.findAll({ where: { scope: 'experience' } });
  const own = rules.filter((r) => {
    const t = Array.isArray(r.targetIds) ? r.targetIds.map(Number) : [];
    return t.length === 1 && t[0] === id;
  });
  for (const r of own) {
    // eslint-disable-next-line no-await-in-loop
    await r.destroy();
  }
  await syncExperienceMarkups();
  const fresh = await loadRules();
  const exp = await Experience.findByPk(id, { attributes: ['id', 'audiences', 'categoryId', 'categoryIds'] });
  if (!exp) return fail(res, 'Experience not found', 404);
  return ok(res, { markup: markupOf(pickRule(fresh, exp)) }, 'Override removed');
});

// ── POST /markup/resync ────────────────────────────────────────────────────
// Manual "re-apply everywhere" (also self-heals rows created before this build).
const resync = asyncHandler(async (req, res) => {
  const sync = await syncExperienceMarkups();
  return ok(res, { sync }, `Markup re-applied — ${sync.updated} experience(s) updated`);
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
  setExperienceOverride,
  clearExperienceOverride,
  resync,
};

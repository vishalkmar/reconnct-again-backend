const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const {
  ConvenienceRule, Experience, ExperienceCategory, ExperienceAudience,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const {
  loadRules, pickRule, feeOf, matches, matchingRules, syncExperienceConvenience,
} = require('../services/convenienceRule.service');
const { taxableBase, withMarkup, convenienceAmount } = require('../utils/goLivePricing');
const { findGlobalRules, collapseGlobalRules } = require('../utils/singleGlobalRule');

/*
  Admin "Pricing Setup Management → Convenience Management".

  Same shape as Markup Management — rules by scope, latest-applied wins, and the
  go-live screen only displays the result with an Edit button for a one-off
  override. The only real difference is where the money lands: the convenience
  fee is charged on the amount that ALREADY includes GST.
*/

const SCOPES = ['all', 'category', 'audience', 'experience'];
const TYPES = ['free', 'fixed', 'percentage'];
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const loadExperiences = async () => Experience.findAll({
  where: { status: { [Op.ne]: 'archived' } },
  attributes: ['id', 'name', 'city', 'location', 'mainImage', 'status', 'isActive',
    'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup', 'discount', 'gstRate', 'gstConfig', 'convenienceFee'],
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

/*
  The per-adult money trail down to the fee, so every table shows the real
  effect rather than just a rule. Mirrors the order the booking engine uses:
  base → markup → discount → GST → convenience.
*/
const breakdownFor = (e, fee) => {
  const quoted = basePriceOf(e);
  const net0 = taxableBase(quoted, e);
  const afterMarkup = withMarkup(net0, e.markup);
  const d = e.discount;
  const discountAmt = d && d.value
    ? (d.type === 'fixed' ? Math.min(num(d.value), afterMarkup) : (afterMarkup * num(d.value)) / 100)
    : 0;
  const net = Math.max(0, afterMarkup - discountAmt);
  const gst = (net * num(e.gstRate)) / 100;
  const afterGst = net + gst;
  const conv = convenienceAmount(afterGst, fee);
  return {
    afterGst: r2(afterGst),
    convenienceAmount: r2(conv),
    payable: r2(afterGst + conv),
  };
};

// ── GET /convenience/rules ─────────────────────────────────────────────────
const listRules = asyncHandler(async (req, res) => {
  const [rules, exps] = await Promise.all([
    ConvenienceRule.findAll({ order: [['appliedAt', 'DESC'], ['id', 'DESC']] }),
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
      cutThrough: num(j.cutThrough),
      targetNames: label(j),
      matchingExperiences: matchCount.get(j.id) || 0,
      effectiveOn: winCount.get(j.id) || 0,
    };
  });
  return ok(res, { items });
});

// ── GET /convenience/targets ───────────────────────────────────────────────
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
      id: e.id, name: e.name, city: e.city || e.location || '', basePrice: basePriceOf(e),
    })),
  });
});

// ── GET /convenience/effective ─────────────────────────────────────────────
const effectiveList = asyncHandler(async (req, res) => {
  const [rules, exps] = await Promise.all([loadRules(), loadExperiences()]);
  const label = await labelTargets(rules);
  const items = exps.map((e) => {
    const win = pickRule(rules, e);
    const fee = feeOf(win);
    return {
      id: e.id,
      name: e.name,
      city: e.city || e.location || '',
      live: isLive(e),
      fee,
      ruleLabel: win ? (win.scope === 'all' ? 'All experiences' : label(win).join(', ')) : null,
      ...breakdownFor(e, fee),
    };
  });
  return ok(res, { items });
});

// ── GET /convenience/experience/:experienceId ──────────────────────────────
const effectiveForExperience = asyncHandler(async (req, res) => {
  const exp = await Experience.findByPk(req.params.experienceId, {
    attributes: ['id', 'name', 'audiences', 'categoryId', 'categoryIds', 'pricing', 'markup', 'discount', 'gstRate', 'gstConfig', 'convenienceFee'],
  });
  if (!exp) return fail(res, 'Experience not found', 404);
  const rules = await loadRules();
  const win = pickRule(rules, exp);
  const label = await labelTargets(rules);
  const fee = feeOf(win);
  return ok(res, {
    experienceId: exp.id,
    fee,
    breakdown: breakdownFor(exp, fee),
    rule: win ? { ...win.toJSON(), value: num(win.value), cutThrough: num(win.cutThrough), targetNames: label(win) } : null,
    otherRules: matchingRules(rules, exp)
      .filter((r) => !win || r.id !== win.id)
      .map((r) => ({ id: r.id, scope: r.scope, type: r.type, value: num(r.value), appliedAt: r.appliedAt, targetNames: label(r) })),
  });
});

const validateRule = (body) => {
  const scope = String(body.scope || '').trim();
  if (!SCOPES.includes(scope)) return { error: 'Pick a valid scope' };
  const type = TYPES.includes(body.type) ? body.type : 'free';
  const value = num(body.value);
  const months = Math.max(0, Math.round(num(body.months)));
  const cutThrough = num(body.cutThrough);
  if (type !== 'free') {
    if (value <= 0) return { error: 'Enter a convenience fee value' };
    if (type === 'percentage' && value > 100) return { error: 'A percentage fee cannot be above 100%' };
  }
  let targetIds = [];
  if (scope !== 'all') {
    targetIds = (Array.isArray(body.targetIds) ? body.targetIds : []).map(Number).filter((n) => n > 0);
    if (!targetIds.length) return { error: 'Select at least one target' };
  }
  return {
    data: {
      scope,
      targetIds,
      type,
      value: type === 'free' ? 0 : value,
      months: type === 'free' ? months : 0,
      cutThrough: type === 'free' ? cutThrough : 0,
      note: (body.note || '').trim() || null,
    },
  };
};

const who = (req) => (req.admin ? (req.admin.name || req.admin.email) : (req.teamMember ? req.teamMember.name : null));

// ── POST /convenience/rules ────────────────────────────────────────────────
const createRule = asyncHandler(async (req, res) => {
  const { error, data } = validateRule(req.body);
  if (error) return fail(res, error, 400);
  const stamp = {
    appliedAt: new Date(),
    createdByAdminId: req.admin ? req.admin.id : null,
    createdByName: who(req),
  };

  // "To All" is the single platform-wide default — a new one replaces the old
  // one rather than stacking a rule that would govern nothing.
  if (data.scope === 'all') {
    const existing = await findGlobalRules(ConvenienceRule);
    if (existing.length) {
      const keep = existing[0];
      await keep.update({ ...data, isActive: true, ...stamp });
      await collapseGlobalRules(ConvenienceRule, keep.id);
      const s = await syncExperienceConvenience();
      return ok(res, { item: keep.toJSON(), sync: s, replaced: true },
        `Platform-wide convenience fee updated — applied to ${s.updated} experience(s)`);
    }
  }

  const rule = await ConvenienceRule.create({ ...data, ...stamp });
  const sync = await syncExperienceConvenience();
  return created(res, { item: rule.toJSON(), sync }, `Convenience fee applied to ${sync.updated} experience(s)`);
});

// ── PUT /convenience/rules/:id ─────────────────────────────────────────────
const updateRule = asyncHandler(async (req, res) => {
  const rule = await ConvenienceRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  const { error, data } = validateRule({ ...rule.toJSON(), ...req.body });
  if (error) return fail(res, error, 400);
  await rule.update({ ...data, appliedAt: new Date() });
  // Editing a rule INTO the 'all' scope must not create a second global default.
  if (data.scope === 'all') await collapseGlobalRules(ConvenienceRule, rule.id);
  const sync = await syncExperienceConvenience();
  return ok(res, { item: rule.toJSON(), sync }, 'Convenience fee updated');
});

// ── PATCH /convenience/rules/:id/toggle ────────────────────────────────────
const toggleRule = asyncHandler(async (req, res) => {
  const rule = await ConvenienceRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  await rule.update({ isActive: !rule.isActive });
  const sync = await syncExperienceConvenience();
  return ok(res, { item: rule.toJSON(), sync }, rule.isActive ? 'Rule resumed' : 'Rule paused');
});

// ── DELETE /convenience/rules/:id ──────────────────────────────────────────
const removeRule = asyncHandler(async (req, res) => {
  const rule = await ConvenienceRule.findByPk(req.params.id);
  if (!rule) return fail(res, 'Rule not found', 404);
  await rule.destroy();
  const sync = await syncExperienceConvenience();
  return ok(res, { sync }, 'Convenience fee rule removed');
});

/*
  ── PUT /convenience/experience/:experienceId ────────────────────────────────
  The go-live screen's Edit — a one-off fee for a single listing, stored as a
  scope:'experience' rule with a fresh appliedAt so it beats the broader rules
  under the same latest-wins logic. Accepts several ids (a direct listing
  publishes N activities together).
*/
const setExperienceOverride = asyncHandler(async (req, res) => {
  const fromParam = req.params.experienceId ? [Number(req.params.experienceId)] : [];
  const fromBody = Array.isArray(req.body.experienceIds) ? req.body.experienceIds.map(Number) : [];
  const targetIds = [...new Set([...fromParam, ...fromBody])].filter((n) => n > 0);
  if (!targetIds.length) return fail(res, 'No experience given', 400);

  const { error, data } = validateRule({ ...req.body, scope: 'experience', targetIds });
  if (error) return fail(res, error, 400);

  const rules = await ConvenienceRule.findAll({ where: { scope: 'experience' } });
  const now = new Date();
  for (const id of targetIds) {
    const own = rules.find((r) => {
      const t = Array.isArray(r.targetIds) ? r.targetIds.map(Number) : [];
      return t.length === 1 && t[0] === id;
    });
    // eslint-disable-next-line no-await-in-loop
    if (own) await own.update({ type: data.type, value: data.value, months: data.months, cutThrough: data.cutThrough, note: data.note, isActive: true, appliedAt: now });
    // eslint-disable-next-line no-await-in-loop
    else await ConvenienceRule.create({
      scope: 'experience',
      targetIds: [id],
      type: data.type,
      value: data.value,
      months: data.months,
      cutThrough: data.cutThrough,
      note: data.note || 'Set from the go-live pricing screen',
      appliedAt: now,
      createdByAdminId: req.admin ? req.admin.id : null,
      createdByName: who(req),
    });
  }
  await syncExperienceConvenience();

  const fresh = await loadRules();
  const exp = await Experience.findByPk(targetIds[0], { attributes: ['id', 'audiences', 'categoryId', 'categoryIds'] });
  return ok(res, { fee: feeOf(pickRule(fresh, exp)) }, 'Convenience fee set for this experience');
});

// ── DELETE /convenience/experience/:experienceId ───────────────────────────
const clearExperienceOverride = asyncHandler(async (req, res) => {
  const id = Number(req.params.experienceId);
  const own = (await ConvenienceRule.findAll({ where: { scope: 'experience' } })).filter((r) => {
    const t = Array.isArray(r.targetIds) ? r.targetIds.map(Number) : [];
    return t.length === 1 && t[0] === id;
  });
  for (const r of own) {
    // eslint-disable-next-line no-await-in-loop
    await r.destroy();
  }
  await syncExperienceConvenience();
  const fresh = await loadRules();
  const exp = await Experience.findByPk(id, { attributes: ['id', 'audiences', 'categoryId', 'categoryIds'] });
  if (!exp) return fail(res, 'Experience not found', 404);
  return ok(res, { fee: feeOf(pickRule(fresh, exp)) }, 'Override removed');
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
};

const { ExperienceCategory, TeamMember, Experience } = require('../models');

/*
  Category Manager ownership.

  A broad category (one of the 10 active experience_categories) is owned by at
  most ONE Category Manager at a time — ownership lives on the category row
  (categoryManagerId). The whole CM dashboard is then scoped to "experiences in
  the categories I own", so this single pointer drives everything.
*/

// The active broad categories, each with who (if anyone) owns it.
const listCategoriesWithOwner = async () => {
  const cats = await ExperienceCategory.findAll({
    where: { isActive: true },
    attributes: ['id', 'name', 'slug', 'categoryManagerId'],
    order: [['sortOrder', 'ASC'], ['name', 'ASC']],
  });
  const ownerIds = [...new Set(cats.map((c) => c.categoryManagerId).filter(Boolean))];
  const owners = ownerIds.length
    ? await TeamMember.findAll({ where: { id: ownerIds }, attributes: ['id', 'name', 'email'] })
    : [];
  const nameById = new Map(owners.map((o) => [o.id, o.name]));
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    categoryManagerId: c.categoryManagerId || null,
    managerName: c.categoryManagerId ? (nameById.get(c.categoryManagerId) || null) : null,
  }));
};

// Category ids currently owned by this CM.
const ownedCategoryIds = async (managerId) => {
  if (!managerId) return [];
  const rows = await ExperienceCategory.findAll({
    where: { categoryManagerId: managerId, isActive: true },
    attributes: ['id'],
  });
  return rows.map((r) => r.id);
};

/*
  Reconcile a CM's owned categories to `nextIds`.

  Adds: each newly-requested category must be FREE (unowned) or already this
  CM's — never stolen from another CM (the form locks those, and this rejects
  it server-side too).

  Removes: taking a category away from a CM is a HANDOFF, never a plain unassign
  — the admin must name the CM to hand it to (handoffs[categoryId] = targetCmId).
  A removal with no target is rejected, so a category is never left ownerless
  once it has had a manager.

  Returns { error } on a violation (nothing is written), else applies and
  returns { moved:[…] } describing handoffs for the caller to notify on.
*/
const applyAssignment = async (managerId, nextIds = [], handoffs = {}) => {
  const want = [...new Set((nextIds || []).map(Number).filter(Boolean))];
  const cats = await ExperienceCategory.findAll({
    where: { isActive: true },
    attributes: ['id', 'name', 'categoryManagerId'],
  });
  const byId = new Map(cats.map((c) => [c.id, c]));
  const current = cats.filter((c) => c.categoryManagerId === managerId).map((c) => c.id);

  const toAdd = want.filter((id) => !current.includes(id));
  const toRemove = current.filter((id) => !want.includes(id));

  // Validate additions — must be free or already ours.
  for (const id of toAdd) {
    const c = byId.get(id);
    if (!c) return { error: `Category ${id} not found` };
    if (c.categoryManagerId && c.categoryManagerId !== managerId) {
      return { error: `"${c.name}" is already assigned to another manager` };
    }
  }
  // Validate removals — each needs a handoff target that is a real, active CM.
  const targets = {};
  for (const id of toRemove) {
    const t = Number(handoffs[id] || handoffs[String(id)]);
    if (!t) return { error: `Choose a manager to hand "${byId.get(id)?.name || id}" over to` };
    if (t === managerId) return { error: 'Hand-off target must be a different manager' };
    targets[id] = t;
  }
  const targetIds = [...new Set(Object.values(targets))];
  if (targetIds.length) {
    const cms = await TeamMember.findAll({
      where: { id: targetIds, roleType: 'category_manager', isActive: true }, attributes: ['id'],
    });
    const ok = new Set(cms.map((m) => m.id));
    for (const id of Object.keys(targets)) {
      if (!ok.has(targets[id])) return { error: 'Hand-off target is not an active Category Manager' };
    }
  }

  // Apply.
  const moved = [];
  for (const id of toAdd) {
    // eslint-disable-next-line no-await-in-loop
    await ExperienceCategory.update({ categoryManagerId: managerId }, { where: { id } });
  }
  for (const id of toRemove) {
    // eslint-disable-next-line no-await-in-loop
    await ExperienceCategory.update({ categoryManagerId: targets[id] }, { where: { id } });
    moved.push({ categoryId: id, categoryName: byId.get(id)?.name, toManagerId: targets[id] });
  }
  return { moved, added: toAdd, removed: toRemove };
};

// Experiences that fall in ANY of these categories. categoryIds is a JSON
// array, which the codebase filters in JS (more reliable than JSON_CONTAINS
// across MySQL versions), so we do the same here.
const experiencesInCategories = async (catIds, { attributes } = {}) => {
  const set = new Set((catIds || []).map(Number));
  if (!set.size) return [];
  const rows = await Experience.findAll(attributes ? { attributes } : {});
  return rows.filter((e) => {
    const cids = Array.isArray(e.categoryIds) ? e.categoryIds : [];
    return cids.some((id) => set.has(Number(id)));
  });
};

/*
  Which Category Managers should hear about this experience — the (active) CM
  owners of every category the experience is filed under. De-duplicated, so a
  listing spanning two of a CM's categories notifies them once.
*/
const managersForExperience = async (exp) => {
  const cids = (exp && Array.isArray(exp.categoryIds) ? exp.categoryIds : []).map(Number);
  if (!cids.length) return [];
  const cats = await ExperienceCategory.findAll({
    where: { id: cids, isActive: true },
    attributes: ['id', 'name', 'categoryManagerId'],
  });
  const byManager = new Map(); // managerId -> categoryName (first match)
  for (const c of cats) {
    if (c.categoryManagerId && !byManager.has(c.categoryManagerId)) byManager.set(c.categoryManagerId, c.name);
  }
  if (!byManager.size) return [];
  const mgrs = await TeamMember.findAll({
    where: { id: [...byManager.keys()], roleType: 'category_manager', isActive: true },
    attributes: ['id', 'name', 'email'],
  });
  return mgrs.map((m) => ({ manager: m, categoryName: byManager.get(m.id) }));
};

/*
  Fire an email + in-app bell to every CM who owns a category this experience
  belongs to. Best-effort and lazily-required to avoid load-time cycles.
  `event` drives the copy (submitted/objection/approved/rejected/live/delisted/
  review). Extra note (objection text, reject reason, review comment) shown too.
*/
const notifyCmOfExperience = async (exp, { event, note, rating } = {}) => {
  try {
    const targets = await managersForExperience(exp);
    if (!targets.length) return;
    // eslint-disable-next-line global-require
    const reviewEmail = require('./reviewEmail.service');
    // eslint-disable-next-line global-require
    const reviewNotify = require('./reviewNotify.service');
    for (const { manager, categoryName } of targets) {
      reviewEmail.notifyCategoryManagerEvent({ manager, exp, event, note, rating, categoryName })
        .catch((e) => console.error('[cm-notify] email failed:', e.message));
      reviewNotify.notify({
        recipientType: 'team', recipientId: manager.id, experienceId: exp.id,
        kind: `cm_${event}`,
        title: CM_TITLES[event] ? CM_TITLES[event](exp) : `Update: "${exp.name}"`,
        message: `${exp.name} — ${categoryName}${note ? ` · ${note}` : ''}`,
        meta: { experienceName: exp.name, categoryName, event },
      }).catch(() => {});
    }
  } catch (e) { console.error('[cm-notify] wiring failed:', e.message); }
};

const CM_TITLES = {
  submitted: (e) => `New listing in your category: "${e.name}"`,
  objection: (e) => `Objection raised: "${e.name}"`,
  approved: (e) => `Content approved: "${e.name}"`,
  rejected: (e) => `Listing rejected: "${e.name}"`,
  live: (e) => `Now live: "${e.name}"`,
  delisted: (e) => `Delisted: "${e.name}"`,
  review: (e) => `New review: "${e.name}"`,
};

module.exports = {
  listCategoriesWithOwner, ownedCategoryIds, applyAssignment, experiencesInCategories,
  managersForExperience, notifyCmOfExperience,
};

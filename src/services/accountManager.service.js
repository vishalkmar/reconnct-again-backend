const { Op } = require('sequelize');
const { Supplier, TeamMember } = require('../models');

/*
  Account Manager round-robin — the moment ANY experience gets linked to a
  supplier (BD adding one for them, or the supplier self-onboarding their
  own), that supplier should have someone watching over them. Rather than a
  stateful rotating pointer (which needs resetting/repairing if a manager is
  deactivated), this picks whichever ACTIVE account_manager currently has the
  FEWEST suppliers assigned — self-correcting, and naturally rebalances if a
  manager goes inactive (their suppliers stop counting against anyone).

  A supplier is assigned exactly ONCE and then keeps that manager for good —
  the only exception being that the manager stops existing as a usable
  contact (deactivated, or the account was deleted). Leaving a supplier
  pointed at a disabled account means their portal shows a manager they can
  never reach, so that case counts as "unassigned" and gets a fresh pick.
*/

// The least-loaded ACTIVE account manager, or null when none exist.
const pickLeastLoaded = async () => {
  const managers = await TeamMember.findAll({ where: { roleType: 'account_manager', isActive: true } });
  if (!managers.length) return null;
  const loads = await Promise.all(
    managers.map((m) => Supplier.count({ where: { accountManagerId: m.id } })),
  );
  let bestIdx = 0;
  for (let i = 1; i < managers.length; i += 1) {
    if (loads[i] < loads[bestIdx]) bestIdx = i;
  }
  return managers[bestIdx];
};

// Is this supplier's current manager still a real, usable contact?
const hasUsableManager = async (supplier) => {
  if (!supplier.accountManagerId) return false;
  const current = await TeamMember.findByPk(supplier.accountManagerId, { attributes: ['id', 'isActive', 'roleType'] });
  return !!(current && current.isActive && current.roleType === 'account_manager');
};

const ensureAccountManagerAssigned = async (supplierId) => {
  if (!supplierId) return;
  const supplier = await Supplier.findByPk(supplierId);
  if (!supplier) return;
  // Already looked after by someone reachable → never reshuffle them.
  if (await hasUsableManager(supplier)) return;

  const pick = await pickLeastLoaded();
  if (!pick) return;

  supplier.accountManagerId = pick.id;
  await supplier.save();
};

/*
  Repair sweep: every supplier whose manager is deactivated (or gone) gets
  handed to the least-loaded active one. Run when a team member is disabled —
  otherwise those suppliers stay orphaned forever, since the assign-on-listing
  hook never fires again once their listings already exist.
*/
const reassignOrphanedSuppliers = async () => {
  const activeIds = (await TeamMember.findAll({
    where: { roleType: 'account_manager', isActive: true },
    attributes: ['id'],
  })).map((m) => m.id);
  // With nobody active to hand them to, leave the stale pointer alone — it's
  // still better provenance than wiping it.
  if (!activeIds.length) return { reassigned: 0 };

  const orphans = await Supplier.findAll({
    where: {
      accountManagerId: { [Op.ne]: null, [Op.notIn]: activeIds },
    },
    attributes: ['id', 'companyName', 'accountManagerId'],
  });

  let reassigned = 0;
  for (const s of orphans) {
    // Re-picked per supplier so the loads rebalance as we go.
    // eslint-disable-next-line no-await-in-loop
    const pick = await pickLeastLoaded();
    if (!pick) break;
    // eslint-disable-next-line no-await-in-loop
    await Supplier.update({ accountManagerId: pick.id }, { where: { id: s.id } });
    reassigned += 1;
  }
  return { reassigned };
};

module.exports = { ensureAccountManagerAssigned, reassignOrphanedSuppliers };

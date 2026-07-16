const { Supplier, TeamMember } = require('../models');

/*
  Account Manager round-robin — the moment ANY experience gets linked to a
  supplier (BD adding one for them, or the supplier self-onboarding their
  own), that supplier should have someone watching over them. Rather than a
  stateful rotating pointer (which needs resetting/repairing if a manager is
  deactivated), this picks whichever ACTIVE account_manager currently has the
  FEWEST suppliers assigned — self-correcting, and naturally rebalances if a
  manager goes inactive (their suppliers stop counting against anyone).
  Assigns exactly once per supplier — a no-op if already assigned.
*/
const ensureAccountManagerAssigned = async (supplierId) => {
  if (!supplierId) return;
  const supplier = await Supplier.findByPk(supplierId);
  if (!supplier || supplier.accountManagerId) return;

  const managers = await TeamMember.findAll({ where: { roleType: 'account_manager', isActive: true } });
  if (!managers.length) return;

  const loads = await Promise.all(
    managers.map((m) => Supplier.count({ where: { accountManagerId: m.id } }))
  );
  let bestIdx = 0;
  for (let i = 1; i < managers.length; i += 1) {
    if (loads[i] < loads[bestIdx]) bestIdx = i;
  }

  supplier.accountManagerId = managers[bestIdx].id;
  await supplier.save();
};

module.exports = { ensureAccountManagerAssigned };

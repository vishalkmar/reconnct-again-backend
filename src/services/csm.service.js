const { User, TeamMember } = require('../models');

/*
  Customer Success Manager round-robin — the customer-side counterpart to
  accountManager.service.js. The moment a customer hits a "needs help"
  signal (a genuinely failed payment, or a cancelled booking), they should
  have someone watching over them. Same least-loaded round robin as Account
  Manager — picks whichever ACTIVE csm-role team member currently has the
  FEWEST customers assigned, self-correcting if a CSM later goes inactive.
  Assigns exactly once per customer — sticky across future incidents.
*/
const ensureCsmAssigned = async (userId) => {
  if (!userId) return;
  const user = await User.findByPk(userId);
  if (!user || user.csmId) return;

  const csms = await TeamMember.findAll({ where: { roleType: 'csm', isActive: true } });
  if (!csms.length) return;

  const loads = await Promise.all(
    csms.map((c) => User.count({ where: { csmId: c.id } }))
  );
  let bestIdx = 0;
  for (let i = 1; i < csms.length; i += 1) {
    if (loads[i] < loads[bestIdx]) bestIdx = i;
  }

  user.csmId = csms[bestIdx].id;
  await user.save();
};

module.exports = { ensureCsmAssigned };

/*
  A pricing rule with scope 'all' is the ONE platform-wide default. Stacking two
  of them is meaningless — latest-wins means the older one silently governs
  nothing, which just reads as a confusing "0 / 108" row in the rules table.

  So a new "To All" rule REPLACES the existing one instead of piling up. The
  narrower scopes (category / audience / experience) legitimately stack, because
  each one can point at a different set of targets — this only applies to 'all'.

  Shared by Markup, GST and Convenience Management so all three behave the same.
*/

// Every scope:'all' row, newest first.
const findGlobalRules = async (Model) => Model.findAll({
  where: { scope: 'all' },
  order: [['appliedAt', 'DESC'], ['id', 'DESC']],
});

// Drop every scope:'all' row except `keepId` (cleans up any pre-existing
// duplicates from before this rule was enforced). Returns how many went.
const collapseGlobalRules = async (Model, keepId) => {
  const rows = await findGlobalRules(Model);
  let removed = 0;
  for (const r of rows) {
    if (r.id === keepId) continue;
    // eslint-disable-next-line no-await-in-loop
    await r.destroy();
    removed += 1;
  }
  return removed;
};

module.exports = { findGlobalRules, collapseGlobalRules };

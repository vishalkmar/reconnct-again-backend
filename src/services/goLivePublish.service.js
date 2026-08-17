const { applyGoLivePricing } = require('../utils/goLivePricing');
const { applyRuleMarkup } = require('./markupRule.service');
const { applyRuleGst } = require('./gstRule.service');
const { applyRuleConvenience } = require('./convenienceRule.service');
const reviewNotify = require('./reviewNotify.service');
const { ensureAccountManagerAssigned, ensureHostAccountManagerAssigned } = require('./accountManager.service');

/*
  Publish an experience straight to LIVE with Center Ops go-live pricing, and
  fire the exact same downstream flow a COPS "direct list" does — KAM round-robin
  assignment + the submitter "it's live" notification/email + the queue-changed
  event. Shared by:
    - reviewQueue.directList (COPS after the content review), and
    - experience.directLive (the BD "Direct listing" add-on),
  so both go-live paths behave identically no matter who triggers them.
*/
const publishLiveExperience = async (item, body = {}, teamMember = null) => {
  applyGoLivePricing(item, body);
  // Markup + GST are never taken from the form as loose numbers — they resolve
  // from the admin's global Pricing Setup rules. `body.gstMode` only records
  // Center Ops's included/double/pure decision for this listing.
  await applyRuleMarkup(item);
  await applyRuleGst(item, body);
  await applyRuleConvenience(item);

  item.status = 'published';
  item.isActive = true;
  item.reviewStage = 'published';
  item.reviewedByTeamMemberId = teamMember ? teamMember.id : (item.reviewedByTeamMemberId || null);
  item.reviewedAt = new Date();
  item.data = { ...(item.data || {}), hostStatus: 'approved', listedAt: (item.data && item.data.listedAt) || new Date().toISOString() };
  await item.save();

  // A supplier gets a KAM the first time one of their listings goes live; a
  // host owns their listings directly and gets one from the same pool.
  if (item.supplierId) ensureAccountManagerAssigned(item.supplierId).catch(() => {});
  if (item.ownerUserId) ensureHostAccountManagerAssigned(item.ownerUserId).catch(() => {});

  await reviewNotify.notifySubmitter(item, {
    kind: 'approved',
    title: `"${item.name}" is now live 🎉`,
    message: 'Listed directly — it’s published on the website and app.',
    meta: { experienceName: item.name },
  }).catch(() => {});
  reviewNotify.emitQueueChanged({ experienceId: item.id });

  return item;
};

module.exports = { publishLiveExperience };

/*
  At go-live, Center Ops sets the final B2B price + GST / discount / convenience
  fee on the experience (the "Live it Now" / "List directly" pricing step). This
  copies those fields off the request body onto the experience row, if present,
  so both go-live paths (reviewQueue.directList + qc.goLive) share one rule.
  B2C pricing + source are the submitter's and are never touched here.

  MARKUP AND GST ARE DELIBERATELY NOT READ FROM THE BODY. Both come from the
  admin's global Pricing Setup rules — see services/markupRule.service.js and
  services/gstRule.service.js, whose applyRuleMarkup()/applyRuleGst() every
  go-live path calls right after this. The go-live form only displays them
  (markup with an Edit button; GST with the Enable → double/pure choice, both of
  which write a per-experience rule instead of a loose value).
*/
const applyGoLivePricing = (item, body = {}) => {
  if (!item || !body || typeof body !== 'object') return;
  if (body.priceMethod !== undefined && body.priceMethod) item.priceMethod = body.priceMethod;
  if (body.pricing !== undefined && body.pricing && typeof body.pricing === 'object') item.pricing = body.pricing;
  if (body.discount !== undefined) item.discount = body.discount || null;
};

/*
  The convenience fee, charged LAST — on the amount that already includes GST.
    free       → nothing (the months / cut-through are display-only)
    fixed      → a flat ₹ amount
    percentage → a % of that post-GST amount
*/
const convenienceAmount = (afterGst, fee) => {
  const a = Number(afterGst) || 0;
  if (!fee || !fee.type || fee.type === 'free') return 0;
  const v = Number(fee.value) || 0;
  if (v <= 0) return 0;
  return fee.type === 'percentage' ? (a * v) / 100 : v;
};

/*
  The base GST is actually charged on.

  Normally that's the quoted B2B price as-is. The exception is 'pure' mode: the
  adder quoted a GST-INCLUSIVE price and Center Ops chose to strip their tax out
  rather than tax it again. Per the business rule chosen, the supplier's GST is
  removed as a flat percentage OF the quoted price:
       base = quoted − quoted × theirRate/100  =  quoted × (1 − theirRate/100).
  e.g. ₹2000 @18% → 2000 × 0.82 = ₹1640.

  In 'double' mode we deliberately leave their GST inside the base — that IS the
  "tax on tax" the mode is named after, chosen knowingly at go-live.
*/
const taxableBase = (base, exp) => {
  const b = Number(base) || 0;
  const cfg = (exp && exp.gstConfig) || {};
  if (cfg.mode !== 'pure') return b;
  const theirRate = Number(cfg.submittedRate ?? (exp && exp.pricing && exp.pricing.gstIncludedRate)) || 0;
  if (theirRate <= 0) return b;
  return b * (1 - theirRate / 100);
};

// The markup amount (in the same unit as `base`) for a given markup config.
const markupAmount = (base, markup) => {
  const b = Number(base) || 0;
  if (!markup || !markup.value) return 0;
  return markup.type === 'fixed' ? (Number(markup.value) || 0) : (b * (Number(markup.value) || 0)) / 100;
};

// The effective per-unit base AFTER markup — this is what the booking actually
// charges (GST etc. then apply on top), so markup is real revenue, not display.
const withMarkup = (base, markup) => (Number(base) || 0) + markupAmount(base, markup);

module.exports = { applyGoLivePricing, markupAmount, withMarkup, taxableBase, convenienceAmount };

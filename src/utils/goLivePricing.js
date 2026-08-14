/*
  At go-live, Center Ops sets the final B2B price + GST / discount / convenience
  fee on the experience (the "Live it Now" / "List directly" pricing step). This
  copies those fields off the request body onto the experience row, if present,
  so both go-live paths (reviewQueue.directList + qc.goLive) share one rule.
  B2C pricing + source are the submitter's and are never touched here.

  MARKUP IS DELIBERATELY NOT READ FROM THE BODY. It comes from the admin's
  global Markup Management rules — see services/markupRule.service.js, whose
  applyRuleMarkup() every go-live path calls right after this. The go-live form
  only displays it (with an Edit button that writes a per-experience rule).
*/
const applyGoLivePricing = (item, body = {}) => {
  if (!item || !body || typeof body !== 'object') return;
  if (body.priceMethod !== undefined && body.priceMethod) item.priceMethod = body.priceMethod;
  if (body.pricing !== undefined && body.pricing && typeof body.pricing === 'object') item.pricing = body.pricing;
  if (body.gstRate !== undefined) item.gstRate = Number(body.gstRate) || 0;
  if (body.discount !== undefined) item.discount = body.discount || null;
  if (body.convenienceFee !== undefined) item.convenienceFee = body.convenienceFee || null;
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

module.exports = { applyGoLivePricing, markupAmount, withMarkup };

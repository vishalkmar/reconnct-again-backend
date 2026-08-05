/*
  At go-live, Center Ops sets the final B2B price + GST / discount / convenience
  fee on the experience (the "Live it Now" / "List directly" pricing step). This
  copies those fields off the request body onto the experience row, if present,
  so both go-live paths (reviewQueue.directList + qc.goLive) share one rule.
  B2C pricing + source are the submitter's and are never touched here.
*/
const applyGoLivePricing = (item, body = {}) => {
  if (!item || !body || typeof body !== 'object') return;
  if (body.priceMethod !== undefined && body.priceMethod) item.priceMethod = body.priceMethod;
  if (body.pricing !== undefined && body.pricing && typeof body.pricing === 'object') item.pricing = body.pricing;
  if (body.gstRate !== undefined) item.gstRate = Number(body.gstRate) || 0;
  if (body.discount !== undefined) item.discount = body.discount || null;
  if (body.convenienceFee !== undefined) item.convenienceFee = body.convenienceFee || null;
};

module.exports = { applyGoLivePricing };

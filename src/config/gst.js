// GST (tax) rates offered across the platform wherever a price is entered.
// 0 = "Off" (no GST — the default). Stored as an integer percent on each
// priced entity and applied as the booking tax line (auto-calculated).
const GST_RATES = [0, 5, 18, 28, 40];

// Coerce arbitrary input to one of the allowed rates; anything unknown → 0 (Off).
const normalizeGstRate = (v) => {
  const n = Math.round(Number(v));
  return GST_RATES.includes(n) ? n : 0;
};

module.exports = { GST_RATES, normalizeGstRate };

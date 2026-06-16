// TCS rates offered wherever admin enters a bookable price.
// 0 = Off. TCS is applied on base price + GST.
const TCS_RATES = [0, 1, 5, 10, 20];

const normalizeTcsRate = (v) => {
  const n = Math.round(Number(v));
  return TCS_RATES.includes(n) ? n : 0;
};

module.exports = { TCS_RATES, normalizeTcsRate };

// How a price is charged. Drives the public unit label AND the booking maths.
//   per_night  → price × nights  (× rooms for hotel rooms)
//   per_person → price × guests
//   package    → flat price for the whole booking
//   custom     → flat price shown under an admin-defined label (priceLabel)
const PRICE_TYPES = ['per_night', 'per_person', 'package', 'custom'];

const normalizePriceType = (v) => (PRICE_TYPES.includes(String(v)) ? String(v) : null);

// Short suffix used after the amount, e.g. "₹2,000 / night".
const priceUnitLabel = (priceType, priceLabel) => {
  switch (priceType) {
    case 'per_night': return 'per night';
    case 'per_person': return 'per person';
    case 'package': return 'package price';
    case 'custom': return String(priceLabel || '').trim() || 'price';
    default: return '';
  }
};

module.exports = { PRICE_TYPES, normalizePriceType, priceUnitLabel };

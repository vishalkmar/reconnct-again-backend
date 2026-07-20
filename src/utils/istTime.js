/*
  Every date+time this product collects (QC visit slots, booking preferred
  times) is an Indian wall-clock time typed by a user in IST, but it's stored
  as bare 'YYYY-MM-DD' + 'HH:mm' strings with no timezone of their own.

  `new Date('2026-07-20T11:40')` resolves those against the SERVER's timezone —
  IST on a dev laptop, UTC in production — so the same row means two different
  instants in the two places. Resolve them explicitly here instead.
*/
const IST_OFFSET_MIN = 5 * 60 + 30; // UTC+5:30

// 'YYYY-MM-DD' + 'HH:mm' (IST wall clock) → real UTC instant, or null.
const istToInstant = (dateStr, timeStr) => {
  const [y, mo, d] = String(dateStr || '').slice(0, 10).split('-').map(Number);
  if (!y || !mo || !d) return null;
  const [hh, mm] = String(timeStr || '00:00').slice(0, 5).split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return new Date(Date.UTC(y, mo - 1, d, hh, mm) - IST_OFFSET_MIN * 60000);
};

module.exports = { IST_OFFSET_MIN, istToInstant };

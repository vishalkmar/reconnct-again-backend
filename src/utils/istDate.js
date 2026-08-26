/**
 * Everything the occasion-greeting engine does is anchored to the Indian
 * calendar day, not the server's. Production runs UTC, so "aaj Diwali hai?"
 * asked at 03:00 UTC would otherwise answer for yesterday, and a 09:30 send
 * time would fire at 15:00 IST.
 *
 * India has a single, fixed +05:30 offset and no DST, so a plain minute shift
 * is exact — no tz database, no dependency. Shift the instant, then read the
 * UTC fields: those ARE the IST calendar fields.
 */

const IST_OFFSET_MIN = 330; // +05:30
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const shifted = (date = new Date()) =>
  new Date(new Date(date).getTime() + IST_OFFSET_MIN * 60 * 1000);

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for the given instant, in IST. */
const istDateKey = (date = new Date()) => {
  const d = shifted(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** { year, month (1-12), day, weekday (0=Sun), hour, minute } in IST. */
const istParts = (date = new Date()) => {
  const d = shifted(date);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
};

/** Minutes elapsed since IST midnight — compared against a campaign's send time. */
const istMinutesOfDay = (date = new Date()) => {
  const { hour, minute } = istParts(date);
  return hour * 60 + minute;
};

/** Calendar arithmetic on a 'YYYY-MM-DD' key. Offset may be negative. */
const addDaysToKey = (key, days) => {
  const [y, m, d] = String(key).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * MS_PER_DAY;
  const out = new Date(t);
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
};

/** { year, month, day, weekday } for a 'YYYY-MM-DD' key (no timezone involved). */
const partsOfKey = (key) => {
  const [y, m, d] = String(key).split('-').map(Number);
  return { year: y, month: m, day: d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
};

/** Whole days from key A to key B (B - A). */
const daysBetweenKeys = (a, b) => {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / MS_PER_DAY);
};

/** '8 Nov 2026' — for admin tables and email copy. */
const prettyKey = (key) => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const { year, month, day } = partsOfKey(key);
  return `${day} ${MONTHS[month - 1] || '?'} ${year}`;
};

module.exports = {
  IST_OFFSET_MIN,
  istDateKey,
  istParts,
  istMinutesOfDay,
  addDaysToKey,
  partsOfKey,
  daysBetweenKeys,
  prettyKey,
};

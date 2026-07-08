const { Experience } = require('../models');

/*
  One canonical availability shape everywhere: schedule.dates =
  [{ date: 'YYYY-MM-DD', slots: [{ start:'HH:MM', end:'HH:MM' }] }].
  That's what the admin Experience builder (ExperienceScheduling.jsx) writes,
  and what both the app's booking calendar and the admin's own view/edit pages
  read. Two other shapes existed in real, already-configured data and were
  invisible to admin/app because nothing read them:

    1. schedule.dateRows — written by the host web/app "create listing" wizard
       (host.controller.js) under a different key. Same inner shape, just
       renamed here (controller now writes `dates` for new saves).

    2. schedule.{availableDays, timeSlots, startDate, endDate} — a legacy
       recurring-weekly-rule shape (seeded demo experiences + some real ones).
       Materialized into concrete dates for a rolling 6-month window using
       the experience's own session duration to turn each point time into a
       start/end slot.

  Idempotent: any experience that already has a non-empty schedule.dates is
  left untouched, so this only ever backfills, never overwrites a real edit.
*/

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const to24h = (t) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
};

const addMinutes = (hhmm, mins) => {
  const [h, m] = hhmm.split(':').map(Number);
  let total = ((h * 60 + m + mins) % 1440 + 1440) % 1440;
  const eh = Math.floor(total / 60);
  const em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
};

const materializeLegacy = (schedule, pricing) => {
  const durationMinutes = ((pricing?.duration?.hours || pricing?.durationHours || 0) * 60)
    + (pricing?.duration?.minutes || pricing?.durationMinutes || 0) || 60;
  const allowed = (schedule.availableDays || []).map((d) => String(d).slice(0, 3));
  const points = (schedule.timeSlots || []).map(to24h).filter(Boolean);
  if (!points.length) return [];

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rangeStart = schedule.startDate ? new Date(schedule.startDate) : today;
  const start = rangeStart > today ? rangeStart : today;
  const maxWindow = new Date(today.getTime() + 183 * 86400000);
  const rangeEnd = schedule.endDate ? new Date(schedule.endDate) : maxWindow;
  const end = rangeEnd < maxWindow ? rangeEnd : maxWindow;

  const dates = [];
  const d = new Date(start);
  while (d <= end) {
    if (allowed.length === 0 || allowed.includes(DOW[d.getDay()])) {
      dates.push({
        date: ymd(d),
        slots: points.map((s) => ({ start: s, end: addMinutes(s, durationMinutes) })),
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
};

const migrate = async () => {
  const rows = await Experience.findAll({ attributes: ['id', 'schedule', 'pricing'] });
  let renamed = 0;
  let materialized = 0;

  for (const row of rows) {
    const schedule = row.schedule || {};
    if (Array.isArray(schedule.dates) && schedule.dates.length > 0) continue; // already canonical

    if (Array.isArray(schedule.dateRows) && schedule.dateRows.length > 0) {
      const { dateRows, ...rest } = schedule;
      // eslint-disable-next-line no-await-in-loop
      await row.update({ schedule: { ...rest, dates: dateRows } });
      renamed += 1;
      continue;
    }

    if (schedule.availableDays || schedule.timeSlots || schedule.startDate || schedule.endDate) {
      const dates = materializeLegacy(schedule, row.pricing || {});
      if (dates.length) {
        // eslint-disable-next-line no-await-in-loop
        await row.update({ schedule: { ...schedule, dates } });
        materialized += 1;
      }
    }
  }

  const changes = [];
  if (renamed) changes.push(`${renamed} experience(s): schedule.dateRows renamed to schedule.dates`);
  if (materialized) changes.push(`${materialized} experience(s): legacy weekly-recurrence schedule materialized into schedule.dates`);
  return { renamed, materialized, changes };
};

module.exports = { migrate };

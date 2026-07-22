/*
  One place that answers "where is this booking in its lifecycle right now".

  The old rule marked a booking COMPLETED the instant its START time passed —
  so a 10–11am experience read as "completed" at 10:00, while the guest was
  literally still there. The fix is to compare against the END instant, and to
  expose the in-between window as ONGOING.

  End instant, in order of preference:
    1. an explicit scheduledEndAt (hotels / multi-day set this)
    2. scheduledAt + the experience's duration
    3. scheduledAt + a default, when no duration is known — so a booking never
       flips to completed the moment it starts, even on legacy rows that never
       stored a duration.
*/
const DEFAULT_DURATION_MIN = 120; // 2h — a safe floor when duration is unknown
const IST_OFFSET_MIN = 5 * 60 + 30; // times in specialRequests are IST wall clock

// Minutes → from an experience's pricing.duration, or the value stored on the
// booking snapshot at creation time. Returns 0 when nothing usable is found.
const durationMinutesOf = (pricingDuration) => {
  if (!pricingDuration) return 0;
  const h = Number(pricingDuration.hours) || 0;
  const m = Number(pricingDuration.minutes) || 0;
  return h * 60 + m;
};

// The booking captures the chosen slot as free text, e.g.
//   "Preferred time: 1:57 PM – 2:00 PM"
// The END of that range is the truest completion moment — better than
// start+duration, which is only a fallback (and wrong when the slot is shorter
// than the listing's nominal duration, as in a 3-minute test slot). Combines
// the end time with the booking's date (IST) into a real UTC instant.
const slotEndInstant = (booking) => {
  const text = String(booking.specialRequests || '');
  const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[–—-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const ymd = String(booking.scheduledFor || booking.scheduledAt || '').slice(0, 10);
  const [y, mo, d] = ymd.split('-').map(Number);
  if (!y || !mo || !d) return null;
  let hh = parseInt(m[4], 10) % 12;
  if (/PM/i.test(m[6])) hh += 12;
  const mm = parseInt(m[5], 10) || 0;
  return Date.UTC(y, mo - 1, d, hh, mm) - IST_OFFSET_MIN * 60000;
};

const endInstant = (booking, durationMinutes) => {
  if (booking.scheduledEndAt) {
    // DATEONLY end — treat as the end of that day so same-day comparisons work.
    const d = new Date(booking.scheduledEndAt);
    if (!Number.isNaN(d.getTime())) return d.getTime() + 24 * 60 * 60 * 1000 - 1;
  }
  // The exact booked slot end, if the range was captured.
  const slotEnd = slotEndInstant(booking);
  if (slotEnd) return slotEnd;
  if (!booking.scheduledAt) return null;
  const start = new Date(booking.scheduledAt).getTime();
  if (Number.isNaN(start)) return null;
  const mins = durationMinutes > 0 ? durationMinutes : DEFAULT_DURATION_MIN;
  return start + mins * 60000;
};

/*
  Lifecycle bucket for a booking:
    'cancelled' | 'upcoming' | 'ongoing' | 'completed'

  `durationMinutes` is optional — pass the experience's real duration when you
  have it; otherwise it falls back to what's on the booking snapshot, then to
  the 2h default.
*/
const bookingLifecycle = (booking, durationMinutes, now = Date.now()) => {
  if (booking.status === 'cancelled' || booking.status === 'refunded') return 'cancelled';
  if (booking.status === 'completed') return 'completed';

  const mins = durationMinutes || Number(booking.itemSnapshot?.durationMinutes) || 0;
  const startIso = booking.scheduledAt;
  if (!startIso) return 'upcoming'; // no known time → can't have happened yet
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return 'upcoming';

  if (now < start) return 'upcoming';
  const end = endInstant(booking, mins);
  if (end && now < end) return 'ongoing';
  return 'completed';
};

// A booking is "done" (reviewable) only once it has actually ENDED.
const isCompleted = (booking, durationMinutes, now = Date.now()) => (
  bookingLifecycle(booking, durationMinutes, now) === 'completed'
);

module.exports = {
  DEFAULT_DURATION_MIN, durationMinutesOf, endInstant, bookingLifecycle, isCompleted,
};

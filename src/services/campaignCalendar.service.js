const {
  istDateKey, istMinutesOfDay, addDaysToKey, partsOfKey, prettyKey,
} = require('../utils/istDate');

/*
  The resolver: "aaj kaunsa occasion due hai?"

  Nothing here sends anything and nothing here touches a network — it is pure
  date arithmetic over the campaign_events rows, which makes the whole engine
  testable and the admin "upcoming schedule" preview exact rather than a guess.

  The core trick is reading the offset backwards. A campaign that fires on
  offsets [-1, 0] does NOT need "is tomorrow Diwali?" logic; for the day we are
  sweeping (sendDate) we simply ask, for each offset:

      occurrenceDate = sendDate - offset

  and then test whether THAT date is an occurrence of the campaign. Diwali on
  8 Nov therefore surfaces on 7 Nov (offset -1) and on 8 Nov (offset 0), with a
  single rule and no special cases.
*/

// Offsets are admin-entered; keep them sane and predictable.
const normaliseOffsets = (raw) => {
  const list = Array.isArray(raw) ? raw : [0];
  const clean = list
    .map((n) => Math.trunc(Number(n)))
    .filter((n) => Number.isFinite(n) && n <= 0 && n >= -30);
  const unique = [...new Set(clean)];
  return unique.length ? unique.sort((a, b) => a - b) : [0];
};

const normaliseChannels = (raw) => {
  const allowed = ['email', 'push', 'inapp'];
  const list = Array.isArray(raw) ? raw : allowed;
  const clean = list.filter((c) => allowed.includes(c));
  return clean.length ? clean : allowed;
};

/**
 * "2nd Sunday of May", "3rd Sunday of June", "1st Sunday of August" — is
 * THIS date that day? Mother's / Father's / Friendship Day move every year but
 * their rule never does, so they are computed rather than re-typed annually.
 *
 * nth: 1-4 counts from the start of the month, -1 means the last one.
 */
const isNthWeekdayOfMonth = (dateKey, { month, weekday, nth }) => {
  const p = partsOfKey(dateKey);
  if (p.month !== Number(month) || p.weekday !== Number(weekday)) return false;
  if (Number(nth) === -1) {
    // Last matching weekday: no other one of its kind later in the month.
    const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
    return p.day + 7 > daysInMonth;
  }
  // The 1st matching weekday falls on day 1-7, the 2nd on 8-14, and so on.
  return Math.ceil(p.day / 7) === Number(nth);
};

/**
 * Is `dateKey` an occurrence of this campaign?
 *
 * 'user_field' campaigns (birthday / anniversary) always answer true: their
 * occurrence is per-user and is resolved in the audience query instead, by
 * matching the user's own dob/anniversary month+day against this date.
 */
const isOccurrence = (campaign, dateKey) => {
  const { month, day, weekday } = partsOfKey(dateKey);
  switch (campaign.recurrence) {
    case 'dates':
      return Array.isArray(campaign.occurrences) && campaign.occurrences.includes(dateKey);
    case 'yearly_fixed':
      return Number(campaign.month) === month && Number(campaign.day) === day;
    case 'nth_weekday':
      return isNthWeekdayOfMonth(dateKey, {
        month: campaign.month,
        weekday: campaign.weekday,
        nth: campaign.nthWeek,
      });
    case 'weekly':
      return Number(campaign.weekday) === weekday;
    case 'user_field':
      return true;
    default:
      return false;
  }
};

/**
 * Every (campaign, occurrenceDate, offsetDay) that should go out on `sendDate`.
 * Pass the campaign rows in; the caller owns the DB query.
 */
const dueOn = (campaigns, sendDate = istDateKey()) => {
  const due = [];
  for (const campaign of campaigns) {
    if (!campaign.isActive) continue;
    for (const offset of normaliseOffsets(campaign.sendOffsets)) {
      const occurrenceDate = addDaysToKey(sendDate, -offset);
      if (isOccurrence(campaign, occurrenceDate)) {
        due.push({ campaign, occurrenceDate, offsetDay: offset, sendDate });
      }
    }
  }
  return due;
};

/** Has this campaign's IST send time passed on the day we're sweeping? */
const sendTimeReached = (campaign, now = new Date()) => {
  const target = Number(campaign.sendHourIst || 0) * 60 + Number(campaign.sendMinuteIst || 0);
  return istMinutesOfDay(now) >= target;
};

/**
 * Forward-looking schedule for the admin calendar: every send that WILL happen
 * in the next `days` days, already expanded per offset. Same dueOn() logic run
 * day by day, so what the admin previews is literally what the sweep will do.
 */
const upcoming = (campaigns, { from = istDateKey(), days = 60 } = {}) => {
  const rows = [];
  for (let i = 0; i < days; i += 1) {
    const sendDate = addDaysToKey(from, i);
    for (const hit of dueOn(campaigns, sendDate)) {
      rows.push({
        campaignId: hit.campaign.id,
        slug: hit.campaign.slug,
        name: hit.campaign.name,
        type: hit.campaign.type,
        recurrence: hit.campaign.recurrence,
        channels: channelsForOffset(hit.campaign, hit.offsetDay),
        sendDate,
        sendDateLabel: prettyKey(sendDate),
        occurrenceDate: hit.occurrenceDate,
        occurrenceLabel: prettyKey(hit.occurrenceDate),
        offsetDay: hit.offsetDay,
        when: hit.offsetDay === 0 ? 'On the day' : `${Math.abs(hit.offsetDay)} day(s) before`,
        // Birthday/anniversary campaigns are "due" every single day — they
        // only fire for the users whose own date matches. The admin timeline
        // filters on this so 365 birthday rows don't bury the festivals.
        perUser: hit.campaign.recurrence === 'user_field',
        sendAt: `${String(hit.campaign.sendHourIst).padStart(2, '0')}:${String(hit.campaign.sendMinuteIst).padStart(2, '0')} IST`,
        needsDateCheck: !!hit.campaign.needsDateCheck,
        // Rows sharing a groupKey go out as ONE message, not several.
        groupKey: groupKeyFor(hit),
      });
    }
  }
  return rows;
};

/** The campaign's next occurrence on/after `from` — null if it has run out. */
const nextOccurrence = (campaign, from = istDateKey()) => {
  if (campaign.recurrence === 'user_field') return null; // per-user, not global
  for (let i = 0; i < 400; i += 1) {
    const key = addDaysToKey(from, i);
    if (isOccurrence(campaign, key)) return key;
  }
  return null;
};

/**
 * Channels for THIS offset, which are not always the campaign's channels.
 *
 * The day-before nudge and the day-of wish deserve different treatment: a
 * push saying "Diwali is tomorrow" is welcome, a second festival EMAIL the
 * day before is how a sending domain gets buried. So `offsetCopy` can carry
 * its own `channels` for an offset; without one, the campaign's list applies.
 */
const channelsForOffset = (campaign, offsetDay) => {
  const override = (campaign.offsetCopy || {})[String(offsetDay)] || {};
  return normaliseChannels(
    Array.isArray(override.channels) && override.channels.length
      ? override.channels
      : campaign.channels
  );
};

/*
  ── Merging occasions that land on the same morning ────────────────────────

  11 Feb 2027 is both Promise Day and Basant Panchami. Two campaigns, two
  notifications, same person, same minute — which reads like a broken system
  even though both are correct. So waves that would reach the SAME people at
  the SAME moment are grouped, and the dispatcher sends ONE message that
  wishes both occasions and suggests experiences for both.

  A "send moment" is (date, time-of-day, audience). All three have to match:

    - date + time, because a 09:30 festival wish and the 18:00 weekend nudge
      are genuinely different moments; merging them would mean one of the two
      goes out at the wrong hour.
    - audience, because a birthday wave reaches only the handful of people
      born today. Folding it into the Diwali blast would wish "happy birthday"
      to the entire customer base.

  This lives here, next to the resolver, so the admin's schedule preview
  groups exactly the way the sweep will.
*/
const TYPE_WEIGHT = {
  festival: 5, holiday: 4, birthday: 4, anniversary: 4, awareness: 3, sale: 2, weekend: 1,
};

const audienceKey = (campaign) => {
  if (campaign.recurrence === 'user_field') return `user:${campaign.userField || 'dob'}`;
  const cities = (campaign.targetCities || []).filter(Boolean).map(String).sort();
  return `all:${cities.join(',')}`;
};

/** Two hits sharing this key are one message. */
const groupKeyFor = (hit) => {
  const c = hit.campaign;
  const time = `${String(c.sendHourIst).padStart(2, '0')}${String(c.sendMinuteIst).padStart(2, '0')}`;
  return `${hit.sendDate}|${time}|${audienceKey(c)}`;
};

/**
 * Orders a group so the occasion that should LEAD the merged message comes
 * first: the bigger kind of day wins, then whichever actually emails, then
 * the older campaign so the order never wobbles between runs.
 */
const leadFirst = (hits) =>
  hits.slice().sort((a, b) => {
    const w = (TYPE_WEIGHT[b.campaign.type] || 0) - (TYPE_WEIGHT[a.campaign.type] || 0);
    if (w) return w;
    const emails = (h) => (channelsForOffset(h.campaign, h.offsetDay).includes('email') ? 1 : 0);
    const e = emails(b) - emails(a);
    if (e) return e;
    return (a.campaign.id || 0) - (b.campaign.id || 0);
  });

/**
 * Fill {{name}} / {{occasion}} / {{coupon}} and pick the right copy for this
 * offset — the day-before line ("kal Diwali hai") is rarely the same sentence
 * as the day-of one ("Happy Diwali").
 */
const renderCopy = (campaign, offsetDay, { name } = {}) => {
  const override = (campaign.offsetCopy || {})[String(offsetDay)] || {};
  const raw = {
    title: override.title || campaign.title || campaign.name,
    message: override.message || campaign.message || '',
  };
  const vars = {
    '{{name}}': (name || 'there').trim().split(/\s+/)[0],
    '{{occasion}}': campaign.name,
    '{{coupon}}': campaign.couponCode || '',
  };
  const apply = (str) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(v), String(str || ''));
  return { title: apply(raw.title), message: apply(raw.message) };
};

module.exports = {
  isNthWeekdayOfMonth,
  normaliseOffsets,
  normaliseChannels,
  channelsForOffset,
  groupKeyFor,
  leadFirst,
  isOccurrence,
  dueOn,
  sendTimeReached,
  upcoming,
  nextOccurrence,
  renderCopy,
};

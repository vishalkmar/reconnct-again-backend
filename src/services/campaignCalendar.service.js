const {
  istDateKey, istMinutesOfDay, addDaysToKey, partsOfKey, prettyKey,
} = require('../utils/istDate');
const {
  countdownCopy, dayOfSell, stageBadge, isRampOffset,
  isCountdownCampaign, COUNTDOWN_OFFSETS,
} = require('./campaignCountdown.service');

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

// A blank line between paragraphs. Copy is stored and rendered as plain text
// (the email turns it into paragraphs with white-space:pre-line), so the
// paragraph break is a real double newline rather than any kind of markup.
const PARA_BREAK = '\n\n';

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
 * The beats this occasion actually sends on.
 *
 * The seven-day run-up is not a feature to switch on — for a festival, a
 * national holiday, a sale or a personal date it is simply how the calendar
 * works, the same way "wish them on the day" is. So the five beats are the
 * DEFAULT here rather than something an admin has to remember to apply, and a
 * calendar seeded before the countdown existed behaves like one seeded after
 * it with no migration and no button.
 *
 * Union, not replacement: anything the admin has added themselves (a -14 for
 * a sale, say) survives. They can only ever end up with more beats than the
 * default, never fewer — which is the safe direction for the one thing that
 * would otherwise fail silently on the morning it mattered.
 */
const effectiveOffsets = (campaign) => {
  const stored = normaliseOffsets(campaign.sendOffsets);
  if (!isCountdownCampaign(campaign)) return stored;
  return normaliseOffsets([...new Set([...stored, ...COUNTDOWN_OFFSETS])]);
};

/**
 * Every (campaign, occurrenceDate, offsetDay) that should go out on `sendDate`.
 * Pass the campaign rows in; the caller owns the DB query.
 */
const dueOn = (campaigns, sendDate = istDateKey()) => {
  const due = [];
  for (const campaign of campaigns) {
    if (!campaign.isActive) continue;
    for (const offset of effectiveOffsets(campaign)) {
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

    /*
      The sweep holds a minor occasion's run-up while a bigger one is still
      ahead, and it groups before deciding — so the preview has to do both, or
      it would promise the admin sends that never happen. Same functions, same
      order as sweepOccasionCampaigns().
    */
    const majorDates = majorOccasionDates(campaigns, sendDate);
    const dayGroups = new Map();
    for (const hit of dueOn(campaigns, sendDate)) {
      const key = groupKeyFor(hit);
      if (!dayGroups.has(key)) dayGroups.set(key, []);
      dayGroups.get(key).push(hit);
    }
    const held = new Set();
    for (const groupHits of dayGroups.values()) {
      const hold = holdForBiggerOccasion(leadFirst(groupHits), majorDates);
      if (hold) groupHits.forEach((h) => held.add(`${h.campaign.id}|${h.offsetDay}`));
    }

    for (const hit of dueOn(campaigns, sendDate)) {
      if (held.has(`${hit.campaign.id}|${hit.offsetDay}`)) continue;
      rows.push({
        // Occasions this send will PREVIEW as "tomorrow" — the Valentine-week
        // chain, shown so the admin can see the linking actually happening.
        previews: lookAheadFor(campaigns, hit, { sendDate })
          .filter((n) => !dayGroups.get(groupKeyFor(hit)).some((h) => h.campaign.id === n.campaign.id))
          .map((n) => n.campaign.name),
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
        // Which beat of the run-up this is ("1 week to go", "Tomorrow"…), so
        // the admin timeline reads as a countdown rather than a list of dates.
        stage: stageBadge(hit.offsetDay),
        isRamp: isRampOffset(hit.offsetDay),
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

const audienceKey = (hit) => {
  const campaign = hit.campaign;
  if (campaign.recurrence === 'user_field') {
    /*
      A personal-date campaign's audience is not "everyone" — it is the people
      whose own dob/anniversary matches THIS hit's occurrenceDate, and each
      offset resolves to a different one. On 27 Aug the birthday campaign's
      offset 0 means "born today" while its offset -7 means "born on 3 Sep":
      two completely disjoint sets of people.

      Leaving occurrenceDate out of the key merged them into one wave, and the
      dispatcher loads the audience from the GROUP LEAD — so the people with a
      birthday next week were never queried, got no "a week to go" message,
      and had that slot claimed for them anyway by a row written against
      today's crowd. Silent, and only visible as birthdays quietly not being
      wished. The occurrence date belongs in the key.
    */
    return `user:${campaign.userField || 'dob'}:${hit.occurrenceDate}`;
  }
  const cities = (campaign.targetCities || []).filter(Boolean).map(String).sort();
  return `all:${cities.join(',')}`;
};

/** Two hits sharing this key are one message. */
const groupKeyFor = (hit) => {
  const c = hit.campaign;
  const time = `${String(c.sendHourIst).padStart(2, '0')}${String(c.sendMinuteIst).padStart(2, '0')}`;
  return `${hit.sendDate}|${time}|${audienceKey(hit)}`;
};

/**
 * Orders a group so the occasion that should LEAD the merged message comes
 * first: the bigger kind of day wins, then whichever actually emails, then
 * the older campaign so the order never wobbles between runs.
 */
const leadFirst = (hits) =>
  hits.slice().sort((a, b) => {
    /*
      Nearest occasion leads. Once occasions run a seven-day countdown, one
      morning can hold Diwali's actual wish AND a teaser for something a week
      out — and "Happy Diwali" is obviously the headline, with the far-off one
      as the footnote, never the other way round.
    */
    const near = Math.abs(a.offsetDay || 0) - Math.abs(b.offsetDay || 0);
    if (near) return near;
    const w = (TYPE_WEIGHT[b.campaign.type] || 0) - (TYPE_WEIGHT[a.campaign.type] || 0);
    if (w) return w;
    const emails = (h) => (channelsForOffset(h.campaign, h.offsetDay).includes('email') ? 1 : 0);
    const e = emails(b) - emails(a);
    if (e) return e;
    return (a.campaign.id || 0) - (b.campaign.id || 0);
  });

/*
  ── Occasions that belong to a bigger one ─────────────────────────────────

  Bhai Dooj falls three days after Diwali. Put it on its own seven-day
  countdown and its first beat lands on 4 November — four days BEFORE Diwali —
  so the customer gets "Bhai Dooj is a week away" while the thing actually on
  their mind is the festival that has not happened yet. It reads as a calendar
  that has lost the plot.

  The rule that fixes it, and the one asked for: while a MAJOR occasion is
  still ahead, a minor one does not start its own run-up. It rides along
  inside the major one's message (the merge below already does that when they
  share a send moment, and lookAheadFor() covers "tomorrow"), and only once
  the major has passed does it begin sending on its own. Diwali therefore
  reads as "Diwali + Bhai Dooj" right up to Diwali, and Bhai Dooj goes solo
  from the 9th.

  "Major" is not a new field to maintain — it is whether the occasion sends
  EMAIL. That is already the line the calendar draws between the six or seven
  occasions worth a mailout and the rest, so it is the same judgement, made
  once.
*/
const isMajorOccasion = (campaign) =>
  (campaign.channels || []).includes('email') && campaign.recurrence !== 'user_field';

/**
 * The next occurrence of each major occasion, from `sendDate`. Computed once
 * per sweep and passed down, because nextOccurrence() walks up to 400 days
 * and this is asked per group.
 */
const majorOccasionDates = (campaigns, sendDate = istDateKey()) => {
  const out = new Map();
  for (const campaign of campaigns) {
    if (!campaign.isActive || !isMajorOccasion(campaign)) continue;
    const next = nextOccurrence(campaign, sendDate);
    if (next) out.set(campaign.id, next);
  }
  return out;
};

/**
 * Is a major occasion due on or before `beforeDate`, i.e. between now and the
 * minor occasion this hit is counting down to? `excludeId` skips the hit's own
 * campaign so a major never holds itself back.
 */
const majorAhead = (majorDates, beforeDate, excludeId) => {
  let earliest = null;
  for (const [id, date] of majorDates) {
    if (id === excludeId) continue;
    // The EARLIEST one, not merely the first the map happens to yield — the
    // date ends up in the admin's run report, and "held until" pointing at
    // the wrong occasion is worse than not saying which.
    if (date <= beforeDate && (!earliest || date < earliest.date)) {
      earliest = { campaignId: id, date };
    }
  }
  return earliest;
};

/**
 * Should this whole group be held rather than sent?
 *
 * Only when EVERY hit in it is a minor occasion's run-up beat — a group that
 * contains a day-of wish, or any major occasion, is the message of the day and
 * always goes. That is what lets Bhai Dooj's "-3" still ride along inside
 * Diwali's day-of message on the 8th while its standalone "-7" on the 4th is
 * held.
 */
const holdForBiggerOccasion = (hits, majorDates) => {
  if (!hits.length) return null;
  const holdable = hits.every((h) => (
    h.offsetDay < 0
    && !isMajorOccasion(h.campaign)
    /*
      The weekly weekend nudge is not a minor occasion waiting its turn — it
      is a standing service message, and "this Saturday" does not become less
      true because a festival falls first. Held once, it would be held every
      week that had a festival in it. Personal dates are excluded for the same
      reason: a birthday belongs to the person, not to the calendar.
    */
    && h.campaign.recurrence !== 'weekly'
    && h.campaign.recurrence !== 'user_field'
  ));
  if (!holdable) return null;
  // The nearest occurrence in the group — the major has to land before that.
  const soonest = hits.map((h) => h.occurrenceDate).sort()[0];
  return majorAhead(majorDates, soonest, hits[0].campaign.id);
};

/*
  ── "And tomorrow…" ───────────────────────────────────────────────────────

  Valentine week is seven occasions in seven days and each only ever knew
  about itself. The person reading Rose Day's wish on the 7th is deciding
  about the 8th, so the day-of message carries a preview of tomorrow's
  occasion with its own suggestions under it.

  Two things are deliberately excluded:

    - occasions that run their own -1 beat. Valentine's Day sends "tomorrow is
      Valentine's" on the 13th by itself; Kiss Day teasing it too would be the
      same news twice in one morning.
    - personal dates. A birthday is one person's, and previewing "tomorrow:
      Birthday" to the whole base is meaningless — their own -1 beat covers it.

  The audience has to match as well, or a city-targeted occasion would be
  previewed to people it will never actually reach.
*/
const lookAheadFor = (campaigns, hit, { sendDate = istDateKey() } = {}) => {
  // Only the day-of message earns an "and tomorrow" — a "3 days to go" mail
  // is already about a future date and does not need a second one.
  if (hit.offsetDay !== 0) return [];

  const tomorrow = addDaysToKey(sendDate, 1);
  const groupAudience = audienceKey(hit);

  return dueOn(campaigns, tomorrow)
    .filter((next) => next.offsetDay === 0)
    .filter((next) => next.campaign.id !== hit.campaign.id)
    .filter((next) => next.campaign.recurrence !== 'user_field')
    .filter((next) => !effectiveOffsets(next.campaign).includes(-1))
    .filter((next) => audienceKey(next) === groupAudience)
    .map((next) => ({ ...next, preview: true }));
};

/**
 * Substitute {{name}} / {{occasion}} / {{coupon}} into an arbitrary pair of
 * strings for one recipient.
 *
 * Separate from renderCopy because not every piece of copy belongs to a beat:
 * the "tomorrow: Propose Day" preview is written about a campaign but is not
 * any of that campaign's own messages, so it needs the tokens filled without
 * renderCopy's beat selection — which would hand back tomorrow's actual wish.
 */
const renderTemplate = (campaign, { title, message }, { name } = {}) => {
  const vars = {
    '{{name}}': (name || 'there').trim().split(/\s+/)[0],
    '{{occasion}}': campaign.name,
    '{{coupon}}': campaign.couponCode || '',
  };
  const apply = (str) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(v), String(str || ''));
  return { title: apply(title), message: apply(message) };
};

/**
 * Fill {{name}} / {{occasion}} / {{coupon}} and pick the right copy for this
 * offset — the day-before line ("kal Diwali hai") is rarely the same sentence
 * as the day-of one ("Happy Diwali").
 */
const renderCopy = (campaign, offsetDay, { name } = {}) => {
  const override = (campaign.offsetCopy || {})[String(offsetDay)] || {};
  /*
    The run-up beats (-7 / -3 / -2 / -1) say something different from the wish
    itself, and nobody is hand-writing five messages for sixty occasions. So
    when the admin has NOT written copy for this beat, the countdown generates
    it — see campaignCountdown.service.js. Admin copy always wins, per field,
    so "I only want to rewrite the day-before line" works.
  */
  const generated = countdownCopy(campaign, offsetDay) || {};
  const raw = {
    title: override.title || generated.title || campaign.title || campaign.name,
    message: override.message || generated.message || campaign.message || '',
  };

  /*
    Day zero sells as well — but underneath the wish, never instead of it. The
    human-written greeting stays exactly as it is and one generated line is
    appended as its own paragraph, which the email then renders below a
    divider (campaignEmail.service.js) so the two halves stay visibly apart.

    Skipped entirely when the admin wrote their own day-of message: at that
    point they have said what they want said, and bolting a sales line onto it
    is us talking over them.
  */
  if (Number(offsetDay) === 0 && !override.message) {
    const sell = dayOfSell(campaign);
    if (sell) raw.message = [raw.message, sell.line].filter(Boolean).join(PARA_BREAK);
  }
  return renderTemplate(campaign, raw, { name });
};

module.exports = {
  isNthWeekdayOfMonth,
  isMajorOccasion,
  majorOccasionDates,
  holdForBiggerOccasion,
  lookAheadFor,
  effectiveOffsets,
  renderTemplate,
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

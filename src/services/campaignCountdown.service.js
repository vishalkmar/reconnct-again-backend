/*
  The festival COUNTDOWN — the run-up, not just the wish.

  A greeting on the morning of Diwali is a nice gesture and a terrible sales
  moment: by then the plan is made, the tickets are bought, the family is
  already in the car. The booking decision happened a week earlier.

  So every big occasion now runs as a five-beat ramp instead of a single wish:

      offset   beat            what it is actually for
      ─────────────────────────────────────────────────────────────────
        -7     "a week to go"  seed the idea while the calendar is empty
        -3     "3 days left"   move from idea to shortlist
        -2     "2 days left"   the last comfortable day to confirm
        -1     "tomorrow"      last call — book tonight
         0     the day         the wish first, then one line that sells today
      ─────────────────────────────────────────────────────────────────

  None of this needed new machinery: campaign_events already carries
  `sendOffsets` (which days) and `offsetCopy` (what to say on each), and the
  resolver already reads an offset backwards into an occurrence date. What was
  missing was the WORDS — five distinct messages per occasion, across sixty
  occasions, is three hundred pieces of copy nobody was ever going to write or
  maintain by hand.

  So the copy is GENERATED here from the occasion's name and type, and only
  when the admin has not written their own: an explicit `offsetCopy[offset]`
  in the DB always wins. Three variants per beat, picked by a stable hash of
  the slug, so Diwali's ramp and Holi's ramp do not read like the same robot
  wrote both — while any single occasion says the same thing every year.

  The day-of WISH is deliberately NOT generated. That one is the campaign's
  own `title`/`message`, written by a human, and it stays that way — the day-of
  mail only adds a selling line beneath it, kept visibly separate. See
  DAY_OF_SELL below.
*/

// The five beats. Ascending, so this drops straight into sendOffsets.
const COUNTDOWN_OFFSETS = [-7, -3, -2, -1, 0];

/*
  Which kinds of occasion get put on the ramp automatically.

  IN — festivals, national holidays, sales, and personal dates (birthday and
  anniversary, which read from PERSONAL_RAMP below). A birthday is the single
  highest-intent date a customer has, and the reason birthday plans fall
  through is that they get made too late — so the run-up is worth more here
  than anywhere.

  OUT — 'awareness' and 'weekend', and both for concrete reasons rather than
  taste:

    - Valentine week alone is seven awareness days in seven days (Rose,
      Propose, Chocolate, Teddy, Promise, Hug, Kiss). Five beats each is 35
      messages in one week, every one of them overlapping the others. It
      would read as a malfunction.
    - The weekend nudge is weekly. A seven-day run-up to Saturday starts on
      the previous Saturday, so every beat of every week collides with every
      beat of the week before it.

  Neither is locked out: an admin can tick -7 on any occasion in the editor,
  and countdownCopy() will generate proper run-up copy for it. This set only
  decides what happens WITHOUT anyone asking.
*/
const COUNTDOWN_TYPES = new Set(['festival', 'holiday', 'sale', 'birthday', 'anniversary']);

const BADGES = {
  '-7': '1 week to go',
  '-3': '3 days to go',
  '-2': '2 days to go',
  '-1': 'Tomorrow',
  0: 'Today',
};

/** Human label for a beat — used by the admin schedule and the email ribbon. */
const stageBadge = (offsetDay) => BADGES[String(Number(offsetDay))]
  || (Number(offsetDay) < 0 ? `${Math.abs(Number(offsetDay))} days to go` : 'Today');

/*
  The copy. Tokens ({{name}}, {{occasion}}, {{coupon}}) are left in place —
  campaignCalendar's renderCopy() substitutes them per recipient exactly as it
  does for admin-written copy, so generated and hand-written copy behave
  identically everywhere downstream.

  Each beat has a job and is written to that job rather than to a generic
  "book now": -7 sells the IDEA, -3 sells the SHORTLIST, -2 sells CONFIRMING,
  -1 sells TONIGHT.
*/
const RAMP = {
  '-7': [
    {
      title: '{{occasion}} is a week away, {{name}} ✨',
      message: 'Seven days is exactly enough time to plan something better than "we will figure it out on the day".\n\nSunrise treks, lakeside camps, quiet tables for two — the good slots go first, and right now every one of them is still open.',
    },
    {
      title: 'One week to {{occasion}}, {{name}}',
      message: 'This is the week everyone else’s calendar fills up.\n\nPick your date now and you still get the experience you actually wanted, not whatever is left on the day.',
    },
    {
      title: '{{occasion}} in 7 days — worth planning properly',
      message: 'A week is enough time to do it right: block the date, pick the place, tell the people.\n\nHere is what is open near you, {{name}}.',
    },
  ],
  '-3': [
    {
      title: '3 days to {{occasion}}, {{name}}',
      message: 'Long enough to plan it. Short enough to stop overthinking it.\n\nThese are filling up for {{occasion}} — pick one today and the date is yours.',
    },
    {
      title: '{{occasion}} is 3 days away 🎉',
      message: 'Still deciding? Here is what people around you are booking for {{occasion}}.\n\nSlots get tighter every day from here.',
    },
    {
      title: 'Three days left, {{name}}',
      message: '{{occasion}} is nearly here.\n\nLock a plan now and spend the next three days looking forward to it instead of scrambling for it.',
    },
  ],
  '-2': [
    {
      title: '2 days to {{occasion}} — plan sorted, {{name}}?',
      message: 'Two days out is when the last good slots disappear.\n\nIf it has been sitting on your list, this is the moment to confirm it.',
    },
    {
      title: '{{occasion}} in 2 days ⏳',
      message: 'Almost here. Most of these confirm instantly — pick a slot now and the day is handled.',
    },
    {
      title: 'Two days left for {{occasion}}',
      message: 'The best-rated ones near you are down to their last few seats, {{name}}.\n\nWorth grabbing yours before tomorrow.',
    },
  ],
  '-1': [
    {
      title: 'Tomorrow is {{occasion}}, {{name}} 🎊',
      message: 'Last chance to turn tomorrow into something you will actually remember.\n\nA few slots are still open near you — book tonight and it is done.',
    },
    {
      title: '{{occasion}} is tomorrow — one thing left to sort',
      message: 'Everything is ready except the plan.\n\nThese can still be booked for tomorrow, {{name}}.',
    },
    {
      title: '1 day to go, {{name}}',
      message: '{{occasion}} tomorrow.\n\nBook tonight, wake up with somewhere to be.',
    },
  ],
};

/*
  ── Personal dates: birthdays and anniversaries ───────────────────────────

  These run the same five beats, but they cannot run the same WORDS. The
  festival ramp is written for a shared date — "these are filling up", "the
  good slots go first" — which is true of Diwali and meaningless about your
  own birthday: nobody else is competing for it, and the pressure is not
  scarcity, it is that people leave their own celebration until it is too
  late to get anyone in one place.

  So the pull here is planning, not scarcity, and the reader is the subject:
  "your birthday", never "{{occasion}}" (which would render as the literal
  campaign name, "Birthday").

  ONE variant per beat, not three, and that is deliberate. Three exist for
  festivals because everyone receives them on the same morning and sixty
  occasions reusing one sentence would be obvious. A birthday ramp is read by
  one person, once a year — and next year they should get the same familiar
  wording, not a shuffled one.
*/
const PERSONAL_RAMP = {
  birthday: {
    '-7': {
      title: 'Your birthday is a week away, {{name}} 🎂',
      message: 'Seven days — which is exactly the amount of notice everyone else needs before they can actually show up.\n\nPick the place now and all you have to do on the day is turn up to it.',
    },
    '-3': {
      title: '3 days to your birthday, {{name}}',
      message: 'Still "we will figure something out"?\n\nHere is the shortcut: pick one of these, send it to the group, done. Most confirm instantly.',
    },
    '-2': {
      title: '2 days to go, {{name}} 🎈',
      message: 'Two days out is the last comfortable moment to book something worth showing up for.\n\nAfter this you are choosing from what is left.',
    },
    '-1': {
      title: 'Your birthday is tomorrow, {{name}}',
      message: 'One day left to make tomorrow more than a cake and a group chat.\n\nA few of these can still be booked for tomorrow.',
    },
  },
  anniversary: {
    '-7': {
      title: 'Your anniversary is a week away, {{name}} 💛',
      message: 'A week is enough to plan something they will not see coming.\n\nQuiet stays, sunset tables, somewhere neither of you has been — all still open at this notice.',
    },
    '-3': {
      title: '3 days to your anniversary, {{name}}',
      message: 'Three days is still enough to do this properly rather than at the last minute.\n\nHere is what is bookable near you.',
    },
    '-2': {
      title: '2 days to go, {{name}}',
      message: 'Two days out. If you have been meaning to book something, this is the evening to do it.',
    },
    '-1': {
      title: 'Your anniversary is tomorrow, {{name}} 💛',
      message: 'Tomorrow is the day. A few of these can still be booked for it — and "I planned something" is a very good sentence to be able to say.',
    },
  },
};

/*
  One line of occasion-appropriate flavour on the early beats. A national
  holiday's pull is the long weekend; a festival's is the people you spend it
  with; a sale's is the price. Same beat, different reason to care.
*/
const TYPE_TAIL = {
  holiday: 'A holiday that lands well is a short trip, not a longer morning in bed.',
  festival: 'The best part of {{occasion}} is who you spend it with. Give them somewhere to spend it.',
  sale: 'Prices are only this good while the sale runs.',
};

/*
  ── The day itself ────────────────────────────────────────────────────────

  Day zero sells too — but it cannot sell the way the run-up does, and it must
  never sell INSTEAD of wishing. Someone opening a Diwali mail on Diwali
  morning wants the wish first; a "3 days left, book now" tone on the actual
  day reads as a shop that forgot what day it is.

  So the day-of message is built in two halves that stay visibly apart:

      1. the WISH — the human-written campaign.title / campaign.message,
         untouched, standing on its own,
      2. then a divider, then ONE selling line written for today
         specifically: what is still bookable, what the long weekend after
         it is for, what to do this evening.

  The email renders that divider literally (see campaignEmail.service.js), so
  the day-of mail does not just READ differently from the countdown mails —
  it is laid out differently, with a festive band instead of a countdown
  ribbon and its own heading over the cards.

  `short` is the same nudge compressed for a notification tray, where the
  wish alone would otherwise use the whole line.
*/
const DAY_OF_LABEL = {
  festival: 'While you are celebrating',
  holiday: 'While you have the day off',
  sale: 'While the sale is on',
  birthday: 'Make a day of it',
  anniversary: 'Make a day of it',
};

const DAY_OF_SELL = {
  festival: [
    {
      line: 'And if the day is still open — plenty of these can be booked for today itself. A few hours out is a better memory than a whole afternoon on the sofa.',
      short: 'Plenty still bookable for today.',
    },
    {
      line: 'Celebrating usually means everyone is finally free on the same day. Here is somewhere to spend it — most of these confirm instantly, so today still works.',
      short: 'Everyone free today? These confirm instantly.',
    },
    {
      line: 'The festival is here, the people are here. All that is missing is somewhere to go — and these are open today.',
      short: 'Open today, near you.',
    },
  ],
  holiday: [
    {
      line: 'A day off is a terrible thing to spend indoors. These are open today and bookable in a minute.',
      short: 'Day off — these are open today.',
    },
    {
      line: 'The holiday is here. If it rolls into a long weekend, this is the cheapest it will be to use it properly.',
      short: 'Long weekend? Use it properly.',
    },
    {
      line: 'Nothing scheduled today is not the same as nothing to do. Here is what is still open near you.',
      short: 'Still open near you today.',
    },
  ],
  sale: [
    {
      line: 'The sale is live right now. Whatever you have been putting off, today is the day it costs the least.',
      short: 'Sale is live — today is the cheapest.',
    },
    {
      line: 'Today is the day. These are the ones worth grabbing before the prices go back up.',
      short: 'Prices go back up after today.',
    },
    {
      line: 'Live now, ending soon. Book today and the price is locked in.',
      short: 'Live now — book today, price locked.',
    },
  ],
  // Personal days sell softly and only about today — nobody wants a discount
  // pitch stapled to "happy birthday".
  birthday: [
    {
      line: 'If nothing is planned yet, plenty of these can still be booked for today. A birthday spent somewhere is a better story than a birthday spent deciding.',
      short: 'Nothing planned? These are open today.',
    },
  ],
  anniversary: [
    {
      line: 'And if today is still open, a fair few of these can be booked for this evening. Worth marking properly.',
      short: 'Still open this evening.',
    },
  ],
};

// Stable per-slug variant pick: one occasion reads the same way every year,
// but two occasions on the same beat do not read identically.
const hashOf = (str) => {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0; // eslint-disable-line no-bitwise
  }
  return Math.abs(h);
};

/** Does this occasion run the full countdown at all? */
const isCountdownCampaign = (campaign) => !!campaign
  && COUNTDOWN_TYPES.has(String(campaign.type || 'festival'));

/** Is `offsetDay` one of the generated run-up beats (i.e. not the day itself)? */
const isRampOffset = (offsetDay) => Number(offsetDay) < 0 && String(Number(offsetDay)) in RAMP;

/**
 * The copy set this occasion's run-up reads from. Personal dates get their
 * own; everything else shares the occasion ramp.
 *
 * Note this is NOT gated on isCountdownCampaign: an admin who ticks -7 by
 * hand on an awareness day should get run-up copy for it, not the same
 * sentence five times. What isCountdownCampaign controls is which occasions
 * get put on the ramp AUTOMATICALLY — a narrower question.
 */
const rampFor = (campaign) => PERSONAL_RAMP[String(campaign.type)] || RAMP;

/**
 * The day-of selling half — the paragraph that comes AFTER the wish, plus its
 * compressed version for a push. Null when this occasion has no day-of sell
 * (an awareness day, a birthday: those are wishes, full stop).
 */
const dayOfSell = (campaign) => {
  if (!isCountdownCampaign(campaign)) return null;
  const variants = DAY_OF_SELL[String(campaign.type)];
  if (!variants) return null;
  const pick = variants[hashOf(campaign.slug || campaign.name || '') % variants.length];
  // The small caption the email prints on the divider between the wish and
  // this line, so the reader is told the subject is changing rather than
  // finding a sales pitch grafted onto a greeting.
  return { ...pick, label: DAY_OF_LABEL[String(campaign.type)] || 'While you are at it' };
};

/**
 * The generated copy for one beat, or null when this campaign/offset has none
 * (the day-of wish, an awareness day, an offset with no template).
 * Tokens are left unsubstituted for renderCopy() to fill in.
 */
const countdownCopy = (campaign, offsetDay) => {
  if (!campaign || !isRampOffset(offsetDay)) return null;
  const entry = rampFor(campaign)[String(Number(offsetDay))];
  if (!entry) return null;

  // The personal ramps hold ONE piece of copy per beat; the occasion ramp
  // holds three and picks by slug (see PERSONAL_RAMP for why they differ).
  const pick = Array.isArray(entry)
    ? entry[hashOf(campaign.slug || campaign.name || '') % entry.length]
    : entry;

  // Flavour only on the two early beats — by "2 days to go" the message is
  // urgency, and a second sentence about togetherness only dilutes it.
  const tail = Number(offsetDay) <= -3 ? TYPE_TAIL[String(campaign.type)] : null;
  return {
    title: pick.title,
    message: tail ? `${pick.message}\n\n${tail}` : pick.message,
  };
};

/**
 * Channels for the ramp.
 *
 * The ask was explicit: every beat emails AND notifies. That is honoured for
 * occasions that email at all — but an occasion the admin deliberately set to
 * push-only (the minor festivals) keeps its whole ramp push-only rather than
 * being quietly promoted to five emails. The campaign's own channel list stays
 * the switch; the ramp only decides the cadence.
 */
const countdownChannels = (campaign) => {
  const base = Array.isArray(campaign.channels) && campaign.channels.length
    ? campaign.channels
    : ['email', 'push', 'inapp'];
  return [...base];
};

/**
 * Rewrites one campaign onto the ramp: the five offsets, plus an explicit
 * per-offset channel list so what the admin SEES in the editor is what will
 * actually go out — no invisible policy.
 *
 * Hand-written offsetCopy is preserved untouched; only `channels` is filled
 * in, and only where the admin has not already chosen one.
 *
 * scope:
 *   'emailing' (default) — occasions that already send email. The big ones.
 *   'all'                — every festival/holiday/sale, emailing or not.
 */
const applyCountdown = (campaign, { scope = 'emailing' } = {}) => {
  if (!isCountdownCampaign(campaign)) return null;
  const emails = (campaign.channels || []).includes('email');
  if (scope === 'emailing' && !emails) return null;

  const offsetCopy = { ...(campaign.offsetCopy || {}) };
  for (const offset of COUNTDOWN_OFFSETS) {
    const key = String(offset);
    const existing = offsetCopy[key] || {};
    if (Array.isArray(existing.channels) && existing.channels.length) continue;
    offsetCopy[key] = { ...existing, channels: countdownChannels(campaign) };
  }
  return { sendOffsets: [...COUNTDOWN_OFFSETS], offsetCopy };
};

/*
  ── "And tomorrow…" ───────────────────────────────────────────────────────

  Valentine week is seven occasions in seven days, and each one only ever knew
  about itself: Rose Day wished you Rose Day and stopped. But the person
  reading it on the 7th is deciding about the 8th — that is the whole shape of
  that week — and a run-up beat cannot fill the gap, because a seven-day
  countdown to Propose Day would start before Rose Day and collide with every
  other day of the week.

  So a day-of message carries a short preview of TOMORROW's occasion, with its
  own suggestions underneath. Not tomorrow's wish — "Happy Propose Day" is
  wrong on the 7th — a preview written in the right tense, pointing at what is
  booking fastest for it.

  Only for occasions that do NOT run their own "tomorrow" beat. Valentine's
  Day itself sends a -1 nudge on the 13th, so Kiss Day teasing it as well
  would be the same message twice; the resolver checks for that (see
  lookAheadFor in campaignCalendar.service).
*/
const TOMORROW_TEASER = {
  title: 'Tomorrow: {{occasion}}',
  message: 'Trending for it right now — and everything here can still be booked for tomorrow.',
};

/** The preview block for an occasion falling tomorrow. Tokens unsubstituted. */
const tomorrowTeaser = () => ({ ...TOMORROW_TEASER });

/** True when a stored row is already on the full ramp. */
const isOnCountdown = (campaign) => {
  const offsets = (campaign.sendOffsets || []).map(Number);
  return COUNTDOWN_OFFSETS.every((o) => offsets.includes(o));
};

module.exports = {
  COUNTDOWN_OFFSETS,
  COUNTDOWN_TYPES,
  stageBadge,
  dayOfSell,
  tomorrowTeaser,
  isCountdownCampaign,
  isRampOffset,
  countdownCopy,
  countdownChannels,
  applyCountdown,
  isOnCountdown,
};

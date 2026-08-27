const {
  Op, fn, col, literal, where: sqlWhere,
} = require('sequelize');
const {
  CampaignEvent, CampaignDispatch, User, Experience,
} = require('../models');
const { istDateKey, partsOfKey } = require('../utils/istDate');
const {
  dueOn, sendTimeReached, channelsForOffset, renderCopy, renderTemplate,
  groupKeyFor, leadFirst, lookAheadFor, majorOccasionDates, holdForBiggerOccasion,
} = require('./campaignCalendar.service');
const { stageBadge, dayOfSell, tomorrowTeaser } = require('./campaignCountdown.service');
const { sendOccasionGreeting } = require('./campaignEmail.service');
const { sendPushToUser } = require('./push.service');
const { makeToken } = require('../utils/unsubscribeToken');
const { makeTrackToken } = require('../utils/campaignTrackToken');

/*
  The dispatcher. Runs on the same periodic sweep as the booking reminders
  (see server.js) and does four things per due campaign:

    1. holds the wave until the campaign's IST send time has passed,
    2. resolves the audience (opted-in users, city filter, and for a
       birthday/anniversary campaign the users whose own date is today),
    3. claims each recipient by INSERTing its campaign_dispatches row FIRST —
       the unique index turns a double-run into a no-op instead of a second
       "Happy Diwali" in someone's inbox,
    4. sends on the free channels only: email, app push, in-app bell.

  Cost is the reason WhatsApp is not in this list. Email/push/in-app cost
  nothing per message, so a festival wave to the whole base is free; adding a
  paid channel later means adding one more case to sendOne() and nothing else.
*/

// A single campaign+offset never processes more than this many people per
// sweep. Anyone left over is simply picked up on the next run 10 minutes
// later — the dispatch table makes that resumable by construction.
const MAX_USERS_PER_RUN = 400;
const EXPERIENCE_POOL = 60;

const CARD_FIELDS = ['id', 'name', 'slug', 'city', 'mainImage'];

/*
  Which experiences to SUGGEST with the wish — the half that turns a greeting
  into a booking. Yoga Day should surface wellness retreats, Bicycle Day
  cycling, Children's Day family outings.

  Four steps, most specific first, each falling through to the next so an
  email never goes out with an empty card list:

    1. promoteExperienceIds — the admin hand-picked these. Nothing overrides it.
    2. audience / category taxonomy — the correct match, once tagged.
    3. suggestKeywords over name / about / location — works on day one,
       before anyone has tagged the catalogue.
    4. recent published experiences.
*/
const loadExperiencePool = async (campaign) => {
  const picked = (campaign.promoteExperienceIds || []).filter(Boolean);
  if (picked.length) {
    const rows = await Experience.findAll({
      where: { id: { [Op.in]: picked } },
      attributes: CARD_FIELDS,
    });
    if (rows.length) return rows.map((r) => r.toJSON());
  }

  const base = { status: 'published' };
  const cities = (campaign.targetCities || []).filter(Boolean);
  if (cities.length) base.city = { [Op.in]: cities };

  const fetch = async (extra) => {
    const rows = await Experience.findAll({
      where: { ...base, ...extra },
      attributes: CARD_FIELDS,
      order: [['updatedAt', 'DESC']],
      limit: EXPERIENCE_POOL,
    });
    return rows.map((r) => r.toJSON());
  };

  // 2 — taxonomy. Both are stored as JSON id-arrays as well as a single FK
  // column, so match either shape rather than silently missing half the rows.
  const audiences = (campaign.targetAudienceIds || []).map(Number).filter(Boolean);
  const categories = (campaign.targetCategoryIds || []).map(Number).filter(Boolean);
  const taxonomyOr = [
    ...audiences.map((id) => literal(`JSON_CONTAINS(\`Experience\`.\`audiences\`, '${id}')`)),
    ...categories.map((id) => literal(`JSON_CONTAINS(\`Experience\`.\`categoryIds\`, '${id}')`)),
    ...(categories.length ? [{ categoryId: { [Op.in]: categories } }] : []),
  ];
  if (taxonomyOr.length) {
    const rows = await fetch({ [Op.or]: taxonomyOr });
    if (rows.length) return rows;
  }

  // 3 — keywords. Cheap LIKE across the three fields that actually describe
  // what an experience IS. Keywords are admin-entered, so they are bound as
  // parameters, never concatenated into the SQL.
  const keywords = (campaign.suggestKeywords || [])
    .map((k) => String(k || '').trim())
    .filter((k) => k.length >= 3)
    .slice(0, 8);
  if (keywords.length) {
    const rows = await fetch({
      [Op.or]: keywords.flatMap((k) => [
        { name: { [Op.like]: `%${k}%` } },
        { about: { [Op.like]: `%${k}%` } },
        { location: { [Op.like]: `%${k}%` } },
      ]),
    });
    if (rows.length) return rows;
  }

  // 4 — anything recent and live.
  return fetch({});
};

/** Cards for this user — from their own city when we have them. */
const pickForUser = (pool, user, limit = 3) => {
  if (!pool.length) return [];
  const mine = user.city
    ? pool.filter((e) => String(e.city || '').toLowerCase() === String(user.city).toLowerCase())
    : [];
  return (mine.length ? mine : pool).slice(0, limit);
};

/**
 * Everyone this campaign should reach on this occurrence.
 *
 * Every campaign in a merged group shares an audience key (same targeting, or
 * the same personal-date field), so this runs once for the group's lead.
 */
const loadAudience = async (campaign, occurrenceDate) => {
  const where = {
    isActive: true,
    marketingOptOutAt: null,
    email: { [Op.ne]: null },
  };
  const cities = (campaign.targetCities || []).filter(Boolean);
  if (cities.length) where.city = { [Op.in]: cities };

  const and = [];
  if (campaign.recurrence === 'user_field') {
    // Birthday / anniversary: the occurrence is the USER's own date, matched
    // on month+day so it repeats every year whatever year is stored.
    const field = campaign.userField === 'anniversary' ? 'anniversary' : 'dob';
    const { month, day } = partsOfKey(occurrenceDate);
    and.push(sqlWhere(fn('MONTH', col(field)), month));
    and.push(sqlWhere(fn('DAY', col(field)), day));
  }

  return User.findAll({
    where: and.length ? { ...where, [Op.and]: and } : where,
    attributes: ['id', 'name', 'email', 'city', 'fcmToken'],
    limit: MAX_USERS_PER_RUN * 3,
  });
};

/*
  A notification tray is not an inbox. The countdown copy is written for the
  email — two or three paragraphs — and Android shows a collapsed
  notification as ONE line, so the whole message becomes a truncated first
  sentence with the point cut off. The push therefore gets the first
  paragraph only, trimmed to something that fits.
*/
const PUSH_BODY_MAX = 160;

const trimTo = (text, max) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trim()}…`;
};

/**
 * @param message   the full rendered copy for this beat
 * @param campaign  needed only on the day itself, for its short sell nudge
 * @param offsetDay which beat this is
 */
const pushBody = (message, campaign, offsetDay) => {
  const first = trimTo(String(message || '').split(/\n\s*\n/)[0], PUSH_BODY_MAX);

  /*
    On the day itself the first paragraph is the WISH, and a wish on its own
    gives the tap no reason to happen. The generated day-of sell carries a
    compressed `short` form for exactly this — appended when the two together
    still fit on a notification line, dropped silently when they do not,
    because a truncated sales fragment is worse than no sales fragment.
  */
  if (Number(offsetDay) === 0) {
    const sell = dayOfSell(campaign || {});
    if (sell && `${first} ${sell.short}`.length <= PUSH_BODY_MAX) return `${first} ${sell.short}`;
  }
  return first;
};

/**
 * Claim + send ONE message for a whole group of occasions.
 *
 * The lead occasion is claimed first: if its row already exists this person
 * has been greeted for this moment, so nothing is sent and the rest of the
 * group is left alone. Once the lead is claimed, every other occasion in the
 * group gets its own dispatch row too — the merged message covered them, and
 * their rows are what stop a later sweep from greeting for them separately.
 *
 * Returns 'sent' | 'failed' | 'duplicate'.
 */
const sendMerged = async ({
  hits, user, channel, copy, experiences, extras,
}) => {
  const [lead, ...rest] = hits;
  const campaign = lead.campaign;

  const rowFor = (hit, extra = {}) => ({
    campaignEventId: hit.campaign.id,
    occurrenceDate: hit.occurrenceDate,
    offsetDay: hit.offsetDay,
    userId: user.id,
    channel,
    status: 'sent',
    title: copy.title,
    body: copy.message,
    imageUrl: campaign.imageUrl || null,
    ctaPath: campaign.ctaPath || '/experiences',
    sentAt: new Date(),
    ...extra,
  });

  let row;
  try {
    row = await CampaignDispatch.create(rowFor(lead));
  } catch (err) {
    // The unique index did its job — this person was already greeted.
    if (err.name === 'SequelizeUniqueConstraintError') return 'duplicate';
    throw err;
  }

  // The tag-along occasions. A duplicate here is harmless: it only means that
  // occasion was already covered, and the lead's row is the one that counts.
  for (const hit of rest) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await CampaignDispatch.create(rowFor(hit, {
        // Marked so the in-app feed shows one greeting, not N identical rows.
        body: `${copy.message || ''}`.trim() || null,
        mergedIntoCampaignId: campaign.id,
      }));
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') {
        console.warn('[occasion] merge claim failed:', hit.campaign.slug, err.message);
      }
    }
  }

  try {
    if (channel === 'email') {
      if (!user.email) throw new Error('no email on account');
      await sendOccasionGreeting({
        to: user.email,
        name: user.name,
        campaign,
        title: copy.title,
        message: copy.message,
        experiences,
        alsoToday: extras,
        offsetDay: lead.offsetDay,
        occurrenceDate: lead.occurrenceDate,
        // The dispatch row is claimed BEFORE the send, so its id already
        // exists here — which is what lets every link in this one mail be
        // attributed to this one person without a second write.
        trackToken: makeTrackToken(row.id),
        unsubToken: makeToken(user.id),
      });
    } else if (channel === 'push') {
      await sendPushToUser(user.id, {
        title: copy.title,
        body: pushBody(copy.message, campaign, lead.offsetDay) || campaign.name,
        data: {
          kind: 'campaign',
          campaignSlug: campaign.slug,
          ctaPath: campaign.ctaPath || '/experiences',
        },
      });
    }
    // 'inapp' needs no send — the row IS the notification, and
    // notification.controller.js reads it into the bell feed.
    return 'sent';
  } catch (err) {
    await row.update({ status: 'failed', error: String(err.message || err).slice(0, 500) });
    return 'failed';
  }
};

/**
 * One person's copy for a merged group: the lead occasion's wish, plus a
 * mention of whatever else falls on the same morning. Push and the bell only
 * get the one-line mention (no room for more); the email gets a proper
 * "Also today" section, built from `extras`.
 */
const buildCopy = (hits, user, lookAhead = []) => {
  const [lead, ...rest] = hits;
  const leadCopy = renderCopy(lead.campaign, lead.offsetDay, { name: user.name });
  if (!rest.length && !lookAhead.length) return { copy: leadCopy, extras: [] };

  const extras = rest.map((h) => ({
    name: h.campaign.name,
    offsetDay: h.offsetDay,
    stage: stageBadge(h.offsetDay),
    ...renderCopy(h.campaign, h.offsetDay, { name: user.name }),
  }));

  /*
    Tomorrow's occasion, previewed on today's wish — the Valentine-week chain,
    where each day points at the next.

    These are NOT dispatch targets: no row is claimed for them, so tomorrow's
    own message still goes out tomorrow exactly as it would have. They ride in
    `extras` purely as content, tagged offsetDay -1 so the email's existing
    "Coming up" section and the sentence below both phrase them as tomorrow's
    without needing a second code path.

    The copy is a PREVIEW, not tomorrow's wish: renderCopy would hand back
    "Happy Propose Day", which is simply wrong on the 7th.
  */
  for (const next of lookAhead) {
    const teaser = tomorrowTeaser();
    extras.push({
      name: next.campaign.name,
      offsetDay: -1,
      stage: 'Tomorrow',
      preview: true,
      ...renderTemplate(next.campaign, teaser, { name: user.name }),
    });
  }

  /*
    Since occasions run a seven-day countdown, the tag-alongs on one morning
    are no longer all "today" — the same email can carry today's wish and a
    teaser for something a week out. Saying "Also Bhai Dooj today" when Bhai
    Dooj is seven days away is worse than not mentioning it, so each extra is
    phrased by its own beat and the two kinds are kept apart in the sentence.
  */
  const phrase = (e) => {
    if (e.offsetDay === 0) return e.name;
    if (e.offsetDay === -1) return `${e.name} tomorrow`;
    return `${e.name} in ${Math.abs(e.offsetDay)} days`;
  };
  const today = extras.filter((e) => e.offsetDay === 0);
  // Nearest first — "Kiss Day tomorrow" belongs at the front of the sentence,
  // not after something a week out.
  const soon = extras.filter((e) => e.offsetDay !== 0)
    .sort((a, b) => Math.abs(a.offsetDay) - Math.abs(b.offsetDay));
  const lines = [
    today.length ? `Also ${today.map(phrase).join(' & ')} today — wishing you a wonderful one!` : null,
    soon.length ? `Coming up: ${soon.map(phrase).join(' · ')}.` : null,
  ].filter(Boolean);

  const message = [leadCopy.message, ...lines].filter(Boolean).join('\n\n');
  return { copy: { title: leadCopy.title, message }, extras };
};

/**
 * Run one due group — one or more occasions sharing a send moment. Every
 * recipient gets exactly ONE message per channel, however many occasions the
 * group holds.
 */
const runGroup = async (rawHits, { lookAhead = [] } = {}) => {
  const hits = leadFirst(rawHits);
  const [lead] = hits;

  // Channels are the union across the group: if any occasion in it emails,
  // the merged message is an email (and covers the others inside it).
  const channels = [...new Set(hits.flatMap((h) => channelsForOffset(h.campaign, h.offsetDay)))];

  // Every campaign in a group shares an audience key, so one query serves all.
  const audience = await loadAudience(lead.campaign, lead.occurrenceDate);

  /*
    A pool per occasion, so the merged email can suggest something for each —
    and one for each look-ahead too, which is the entire point of previewing
    tomorrow: "here is what is trending for Propose Day" needs Propose Day's
    own suggestions, not today's.
  */
  const carded = [...hits, ...lookAhead];
  const pools = channels.includes('email')
    ? await Promise.all(carded.map((h) => loadExperiencePool(h.campaign)))
    : carded.map(() => []);

  const stats = {
    sent: 0, failed: 0, duplicate: 0, users: 0,
  };
  let handled = 0;

  for (const user of audience) {
    if (handled >= MAX_USERS_PER_RUN) break;
    const { copy, extras } = buildCopy(hits, user, lookAhead);
    // The lead occasion gets the top cards; each tag-along gets its own pair,
    // so a merged Promise Day + Basant Panchami email suggests for both.
    const experiences = pickForUser(pools[0], user, carded.length > 1 ? 2 : 3);
    extras.forEach((extra, i) => {
      extra.experiences = pickForUser(pools[i + 1] || [], user, 2);
    });
    let touched = false;

    for (const channel of channels) {
      // Skip push for a device we don't have — it would only ever be a
      // 'failed' row and would bury the real failures in the admin log.
      if (channel === 'push' && !user.fcmToken) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await sendMerged({
          hits, user, channel, copy, experiences, extras,
        });
        stats[result] += 1;
        if (result !== 'duplicate') touched = true;
      } catch (err) {
        stats.failed += 1;
        console.error('[occasion] dispatch failed:', lead.campaign.slug, user.id, channel, err.message);
      }
    }
    if (touched) { handled += 1; stats.users += 1; }
  }

  return stats;
};

/**
 * The entry point server.js calls. `force` (admin "Run now") skips the
 * send-time gate but NOT the duplicate guard — a manual run can bring a
 * delayed wave forward, never re-send one that already went out.
 */
const sweepOccasionCampaigns = async ({ sendDate = istDateKey(), force = false, only = null } = {}) => {
  const where = { isActive: true };
  if (only) where.id = only;
  const campaigns = await CampaignEvent.findAll({ where });
  const due = dueOn(campaigns, sendDate);

  /*
    "Everything" — not just the campaigns this run is scoped to. The admin's
    "Run now" can target one campaign (`only`), but whether a minor occasion
    should hold for a bigger one, and what falls tomorrow, are questions about
    the WHOLE calendar. Answering them from a filtered list would make a
    single-campaign test run behave differently from the real sweep.
  */
  const all = only
    ? (await CampaignEvent.findAll({ where: { isActive: true } })).map((c) => c.toJSON())
    : campaigns.map((c) => c.toJSON());
  const majorDates = majorOccasionDates(all, sendDate);

  // Bucket everything due into send moments before sending anything, so two
  // occasions on one morning become one message instead of two.
  const groups = new Map();
  const report = [];
  for (const hit of due) {
    if (!force && !sendTimeReached(hit.campaign)) {
      report.push({ slug: hit.campaign.slug, offsetDay: hit.offsetDay, skipped: 'before send time' });
      continue;
    }
    const key = groupKeyFor(hit);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hit);
  }

  for (const hits of groups.values()) {
    const ordered = leadFirst(hits);
    const names = ordered.map((h) => h.campaign.name);

    /*
      Hold a minor occasion's run-up while a bigger one is still ahead of it —
      Bhai Dooj does not start counting down four days before Diwali. It still
      rides along inside Diwali's own message when they share a morning (this
      group would contain both, so it is not holdable), and it starts sending
      on its own the day after Diwali passes.
    */
    const held = holdForBiggerOccasion(ordered, majorDates);
    if (held) {
      report.push({
        slug: ordered[0].campaign.slug,
        name: names.join(' + '),
        offsetDay: ordered[0].offsetDay,
        skipped: `held — a bigger occasion lands first (${held.date})`,
      });
      continue;
    }

    // Tomorrow's occasion, previewed on today's wish (the Valentine-week
    // chain). Content only — no dispatch row is claimed for it.
    const lookAhead = lookAheadFor(all, ordered[0], { sendDate })
      .filter((next) => !ordered.some((h) => h.campaign.id === next.campaign.id));

    try {
      // eslint-disable-next-line no-await-in-loop
      const stats = await runGroup(ordered, { lookAhead });
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(ordered.map((h) => h.campaign.update({ lastRunAt: new Date() })));
      report.push({
        slug: ordered[0].campaign.slug,
        name: names.join(' + '),
        merged: names.length > 1 ? names : undefined,
        previewing: lookAhead.length ? lookAhead.map((n) => n.campaign.name) : undefined,
        occurrenceDate: ordered[0].occurrenceDate,
        offsetDay: ordered[0].offsetDay,
        ...stats,
      });
      if (stats.sent) {
        console.log(
          '[occasion] %s (%s): %d sent, %d failed%s',
          names.join(' + '), ordered[0].occurrenceDate, stats.sent, stats.failed,
          names.length > 1 ? ` — merged into one message` : ''
        );
      }
    } catch (err) {
      console.error('[occasion] wave failed:', names.join(' + '), err.message);
      report.push({ slug: ordered[0].campaign.slug, name: names.join(' + '), error: err.message });
    }
  }
  return {
    sendDate, due: due.length, groups: groups.size, report,
  };
};

module.exports = {
  sweepOccasionCampaigns, runGroup, groupKeyFor, leadFirst, buildCopy,
  loadExperiencePool, loadAudience,
};

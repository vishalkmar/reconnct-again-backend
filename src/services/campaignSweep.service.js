const {
  Op, fn, col, literal, where: sqlWhere,
} = require('sequelize');
const {
  CampaignEvent, CampaignDispatch, User, Experience,
} = require('../models');
const { istDateKey, partsOfKey } = require('../utils/istDate');
const {
  dueOn, sendTimeReached, channelsForOffset, renderCopy, groupKeyFor, leadFirst,
} = require('./campaignCalendar.service');
const { sendOccasionGreeting } = require('./campaignEmail.service');
const { sendPushToUser } = require('./push.service');
const { makeToken } = require('../utils/unsubscribeToken');

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
        unsubToken: makeToken(user.id),
      });
    } else if (channel === 'push') {
      await sendPushToUser(user.id, {
        title: copy.title,
        body: copy.message || campaign.name,
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
const buildCopy = (hits, user) => {
  const [lead, ...rest] = hits;
  const leadCopy = renderCopy(lead.campaign, lead.offsetDay, { name: user.name });
  if (!rest.length) return { copy: leadCopy, extras: [] };

  const extras = rest.map((h) => ({
    name: h.campaign.name,
    ...renderCopy(h.campaign, h.offsetDay, { name: user.name }),
  }));
  const names = extras.map((e) => e.name).join(' & ');
  const message = [leadCopy.message, `Also ${names} today — wishing you a wonderful one!`]
    .filter(Boolean)
    .join('\n\n');
  return { copy: { title: leadCopy.title, message }, extras };
};

/**
 * Run one due group — one or more occasions sharing a send moment. Every
 * recipient gets exactly ONE message per channel, however many occasions the
 * group holds.
 */
const runGroup = async (rawHits) => {
  const hits = leadFirst(rawHits);
  const [lead] = hits;

  // Channels are the union across the group: if any occasion in it emails,
  // the merged message is an email (and covers the others inside it).
  const channels = [...new Set(hits.flatMap((h) => channelsForOffset(h.campaign, h.offsetDay)))];

  // Every campaign in a group shares an audience key, so one query serves all.
  const audience = await loadAudience(lead.campaign, lead.occurrenceDate);

  // A pool per occasion, so the merged email can suggest something for each.
  const pools = channels.includes('email')
    ? await Promise.all(hits.map((h) => loadExperiencePool(h.campaign)))
    : hits.map(() => []);

  const stats = {
    sent: 0, failed: 0, duplicate: 0, users: 0,
  };
  let handled = 0;

  for (const user of audience) {
    if (handled >= MAX_USERS_PER_RUN) break;
    const { copy, extras } = buildCopy(hits, user);
    // The lead occasion gets the top cards; each tag-along gets its own pair,
    // so a merged Promise Day + Basant Panchami email suggests for both.
    const experiences = pickForUser(pools[0], user, hits.length > 1 ? 2 : 3);
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
    try {
      // eslint-disable-next-line no-await-in-loop
      const stats = await runGroup(ordered);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(ordered.map((h) => h.campaign.update({ lastRunAt: new Date() })));
      report.push({
        slug: ordered[0].campaign.slug,
        name: names.join(' + '),
        merged: names.length > 1 ? names : undefined,
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

const asyncHandler = require('express-async-handler');
const { Op, fn, col, literal } = require('sequelize');
const {
  CampaignEvent, CampaignDispatch, User, Booking,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const { istDateKey, prettyKey, addDaysToKey } = require('../utils/istDate');
const {
  upcoming, nextOccurrence, normaliseOffsets, normaliseChannels, renderCopy, effectiveOffsets,
} = require('../services/campaignCalendar.service');
const { sweepOccasionCampaigns, loadExperiencePool } = require('../services/campaignSweep.service');
const { sendOccasionGreeting } = require('../services/campaignEmail.service');
const { sendPushToUser } = require('../services/push.service');
const { isCountdownCampaign, stageBadge } = require('../services/campaignCountdown.service');
const { seedCampaignCalendar } = require('../seeders/seedCampaignCalendar');
const { makeToken, readToken } = require('../utils/unsubscribeToken');
const { makeTrackToken, readTrackToken } = require('../utils/campaignTrackToken');

/*
  Admin → Occasion Marketing. CRUD over the greeting calendar plus the three
  things an admin actually needs before trusting an automated send:

    - upcoming(): exactly which messages will go out on which day, expanded
      per offset. Same resolver the sweep uses, so the preview cannot drift
      from reality.
    - test(): the real email/push to one address, bypassing the audience.
    - runNow(): force a due wave early. Duplicate protection still applies.
*/

const slugify = (str) =>
  String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

const EDITABLE = [
  'name', 'type', 'recurrence', 'occurrences', 'month', 'day', 'weekday', 'nthWeek', 'userField',
  'needsDateCheck', 'sendOffsets', 'sendHourIst', 'sendMinuteIst', 'channels',
  'title', 'message', 'offsetCopy', 'imageUrl', 'ctaLabel', 'ctaPath', 'couponCode',
  'targetCities', 'targetCategoryIds', 'targetAudienceIds', 'promoteExperienceIds',
  'suggestKeywords', 'isActive',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates and normalises one payload. Returns { values } or { error }.
const buildPayload = (body, { partial = false } = {}) => {
  const v = {};
  for (const key of EDITABLE) if (key in body) v[key] = body[key];

  if (!partial || 'name' in v) {
    if (!String(v.name || '').trim()) return { error: 'Name is required' };
    v.name = String(v.name).trim().slice(0, 160);
  }
  if (!partial || 'title' in v) {
    if (!String(v.title || '').trim()) return { error: 'Title is required' };
    v.title = String(v.title).trim().slice(0, 200);
  }

  if ('sendOffsets' in v) v.sendOffsets = normaliseOffsets(v.sendOffsets);
  if ('channels' in v) v.channels = normaliseChannels(v.channels);

  if ('sendHourIst' in v) {
    const h = Number(v.sendHourIst);
    if (!Number.isInteger(h) || h < 0 || h > 23) return { error: 'Send hour must be 0-23' };
    v.sendHourIst = h;
  }
  if ('sendMinuteIst' in v) {
    const m = Number(v.sendMinuteIst);
    if (!Number.isInteger(m) || m < 0 || m > 59) return { error: 'Send minute must be 0-59' };
    v.sendMinuteIst = m;
  }

  // Each recurrence needs its own field filled in, or the campaign silently
  // never fires — reject it here instead of at 9:30am on Diwali.
  const rec = v.recurrence;
  if (rec === 'dates') {
    const list = (Array.isArray(v.occurrences) ? v.occurrences : [])
      .map((d) => String(d).trim())
      .filter(Boolean);
    if (!list.length) return { error: 'Add at least one date' };
    const bad = list.find((d) => !DATE_RE.test(d));
    if (bad) return { error: `"${bad}" is not a YYYY-MM-DD date` };
    v.occurrences = [...new Set(list)].sort();
  } else if (rec === 'yearly_fixed') {
    const month = Number(v.month);
    const day = Number(v.day);
    if (!(month >= 1 && month <= 12)) return { error: 'Month must be 1-12' };
    if (!(day >= 1 && day <= 31)) return { error: 'Day must be 1-31' };
    v.month = month; v.day = day;
  } else if (rec === 'nth_weekday') {
    // "2nd Sunday of May" — Mother's/Father's/Friendship Day.
    const month = Number(v.month);
    const wd = Number(v.weekday);
    const nth = Number(v.nthWeek);
    if (!(month >= 1 && month <= 12)) return { error: 'Month must be 1-12' };
    if (!(wd >= 0 && wd <= 6)) return { error: 'Weekday must be 0 (Sun) - 6 (Sat)' };
    if (!([1, 2, 3, 4, -1].includes(nth))) return { error: 'Pick 1st-4th, or last' };
    v.month = month; v.weekday = wd; v.nthWeek = nth;
  } else if (rec === 'weekly') {
    const wd = Number(v.weekday);
    if (!(wd >= 0 && wd <= 6)) return { error: 'Weekday must be 0 (Sun) - 6 (Sat)' };
    v.weekday = wd;
  } else if (rec === 'user_field') {
    v.userField = v.userField === 'anniversary' ? 'anniversary' : 'dob';
  }

  for (const jsonKey of [
    'targetCities', 'targetCategoryIds', 'targetAudienceIds',
    'promoteExperienceIds', 'suggestKeywords',
  ]) {
    if (jsonKey in v && !Array.isArray(v[jsonKey])) v[jsonKey] = [];
  }
  if (Array.isArray(v.suggestKeywords)) {
    v.suggestKeywords = v.suggestKeywords
      .map((k) => String(k || '').trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  return { values: v };
};

// Sent/failed counts per campaign, in one grouped query rather than N.
const dispatchStats = async () => {
  const rows = await CampaignDispatch.findAll({
    attributes: [
      'campaignEventId',
      'status',
      [fn('COUNT', col('id')), 'n'],
    ],
    group: ['campaignEventId', 'status'],
    raw: true,
  });
  const map = new Map();
  for (const r of rows) {
    const entry = map.get(r.campaignEventId) || { sent: 0, failed: 0 };
    entry[r.status === 'failed' ? 'failed' : 'sent'] += Number(r.n);
    map.set(r.campaignEventId, entry);
  }
  return map;
};

// GET /api/admin/campaigns
const list = asyncHandler(async (req, res) => {
  const [campaigns, stats] = await Promise.all([
    CampaignEvent.findAll({ order: [['type', 'ASC'], ['name', 'ASC']] }),
    dispatchStats(),
  ]);
  const today = istDateKey();

  const items = campaigns.map((c) => {
    const json = c.toJSON();
    const next = nextOccurrence(json, today);
    return {
      ...json,
      nextOccurrence: next,
      nextOccurrenceLabel: next ? prettyKey(next) : null,
      stats: stats.get(json.id) || { sent: 0, failed: 0 },
      /*
        The beats that will ACTUALLY fire, not the ones stored. The run-up is
        the default for a festival now rather than something applied, so a row
        seeded with [-1, 0] really sends five — and an editor showing the
        stored pair would simply be lying about the schedule.
      */
      sendOffsets: effectiveOffsets(json),
      storedOffsets: json.sendOffsets,
      onCountdown: isCountdownCampaign(json),
    };
  });

  return ok(res, {
    campaigns: items,
    today,
    needsDateCheck: items.filter((c) => c.needsDateCheck && c.isActive).length,
  });
});

// GET /api/admin/campaigns/upcoming?days=60
const upcomingSchedule = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 365);
  const campaigns = (await CampaignEvent.findAll({ where: { isActive: true } }))
    .map((c) => c.toJSON());
  const rows = upcoming(campaigns, { from: istDateKey(), days });
  return ok(res, { from: istDateKey(), days, sends: rows });
});

// POST /api/admin/campaigns
const create = asyncHandler(async (req, res) => {
  const { values, error } = buildPayload(req.body || {});
  if (error) return fail(res, error, 400);

  const slug = slugify(req.body.slug || values.name);
  if (!slug) return fail(res, 'Could not derive a slug from the name', 400);
  if (await CampaignEvent.findOne({ where: { slug } })) {
    return fail(res, `A campaign with slug "${slug}" already exists`, 409);
  }

  const row = await CampaignEvent.create({ ...values, slug });
  return created(res, { campaign: row.toJSON() }, 'Campaign created');
});

// PUT /api/admin/campaigns/:id
const update = asyncHandler(async (req, res) => {
  const row = await CampaignEvent.findByPk(req.params.id);
  if (!row) return fail(res, 'Campaign not found', 404);

  // Merge onto the stored row before validating, so a partial edit of a
  // 'dates' campaign isn't rejected for "no dates" it never sent back.
  const merged = { ...row.toJSON(), ...(req.body || {}) };
  const { values, error } = buildPayload(merged);
  if (error) return fail(res, error, 400);

  await row.update(values);
  return ok(res, { campaign: row.toJSON() }, 'Campaign updated');
});

// PATCH /api/admin/campaigns/:id/toggle
const toggle = asyncHandler(async (req, res) => {
  const row = await CampaignEvent.findByPk(req.params.id);
  if (!row) return fail(res, 'Campaign not found', 404);
  await row.update({ isActive: !row.isActive });
  return ok(res, { campaign: row.toJSON() }, row.isActive ? 'Campaign activated' : 'Campaign paused');
});

// PATCH /api/admin/campaigns/:id/verify-dates — a human has confirmed the
// lunar dates; drop the warning chip.
const verifyDates = asyncHandler(async (req, res) => {
  const row = await CampaignEvent.findByPk(req.params.id);
  if (!row) return fail(res, 'Campaign not found', 404);
  await row.update({ needsDateCheck: false });
  return ok(res, { campaign: row.toJSON() }, 'Dates marked as verified');
});

// DELETE /api/admin/campaigns/:id
const remove = asyncHandler(async (req, res) => {
  const row = await CampaignEvent.findByPk(req.params.id);
  if (!row) return fail(res, 'Campaign not found', 404);
  await row.destroy(); // dispatch log cascades
  return ok(res, {}, 'Campaign deleted');
});

/*
  POST /api/admin/campaigns/:id/test  { email, offsetDay, userId }

  Sends the REAL greeting to one address so the admin can see the actual
  email before a wave goes out. Deliberately does NOT write a dispatch row:
  a test must never consume a recipient's real slot for the occasion.
*/
/*
  A test send has to be TRACKED, or it cannot do the one job a test exists for.

  Until now the test path deliberately created no dispatch row and passed no
  track token — the reasoning being that a test must never consume somebody's
  real greeting slot or inflate the numbers. Both of those are still true. But
  the consequence was that the only tool an admin has for producing a greeting
  on demand produced the ONE kind of greeting whose links cannot be measured,
  so "is tracking working?" was unanswerable by any means available in the
  product.

  So a test now gets a real dispatch row, with three things that keep it from
  contaminating anything:

    - `isTest: true`, and every report filters these out by default.
    - `occurrenceDate` is TODAY, not the occasion's real date. That is what
      stops it colliding with the genuine row for Diwali-on-8-Nov and stealing
      that person's actual wish — the unique index is
      (campaign, occurrenceDate, offset, user, channel), so a different date is
      a different slot.
    - a repeat test on the same day REUSES the row instead of failing on the
      unique index, so the admin can press the button as often as they like.

  Needs a User to attach to. Where the test address has no account, the mail
  still goes out — just unmeasured, and the response says so rather than
  silently producing a link that records nothing.
*/
const testDispatchFor = async ({ campaign, offsetDay, userId, channel }) => {
  if (!userId) return null;
  const today = istDateKey();
  const key = {
    campaignEventId: campaign.id,
    occurrenceDate: today,
    offsetDay,
    userId,
    channel,
  };
  try {
    return await CampaignDispatch.create({
      ...key,
      status: 'sent',
      isTest: true,
      title: `[test] ${campaign.name}`,
      ctaPath: campaign.ctaPath || '/experiences',
      sentAt: new Date(),
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      // Tested this beat already today — reuse the row so the same link keeps
      // reporting rather than the button failing on the second press.
      const existing = await CampaignDispatch.findOne({ where: key });
      if (existing) {
        await existing.update({
          sentAt: new Date(), openedAt: null, clickedAt: null, clickCount: 0,
          clickKind: null, clickVia: null, landedAt: null, dwellSeconds: null,
        });
        return existing;
      }
    }
    console.warn('[occasion] test dispatch row failed:', err.message);
    return null;
  }
};

const test = asyncHandler(async (req, res) => {
  const row = await CampaignEvent.findByPk(req.params.id);
  if (!row) return fail(res, 'Campaign not found', 404);

  const campaign = row.toJSON();
  const offsetDay = Number(req.body?.offsetDay ?? 0);
  const name = String(req.body?.name || req.admin?.name || 'there');

  /*
    One click has to exercise BOTH channels, because the two fail in
    completely different ways and an admin who only ever sees the email has
    no idea whether the phone would have buzzed.

    Defaults are chosen so the button works with nothing typed in: the
    signed-in admin's own address, and the app account registered against
    that same address for the push. Anything explicit in the body wins.
  */
  // req.admin, not req.user — this router runs the ADMIN authenticate
  // middleware, which attaches the Admin row.
  const email = String(req.body?.email || req.admin?.email || '').trim();
  const wantEmail = req.body?.email !== '' && !!email;
  const wantPush = req.body?.push !== false;

  /*
    Resolve the target account ONCE, and independently of whether a push was
    asked for. It was previously looked up only on the push path, which meant
    an email-only test had no user to attach a dispatch row to and therefore
    went out untracked — the tracking of a mail has nothing to do with whether
    a notification was also requested.
  */
  let targetUserId = Number(req.body?.userId) || null;
  if (!targetUserId && email) {
    // The app account that owns this address — that is the phone and inbox
    // the admin is holding, which is where the test should land.
    const target = await User.findOne({ where: { email }, attributes: ['id'] });
    targetUserId = target ? target.id : null;
  }
  const pushUserId = targetUserId;
  if (!wantEmail && !wantPush) return fail(res, 'Nothing to test — pick email, push, or both', 400);

  const copy = renderCopy(campaign, offsetDay, { name });
  const result = { email: null, push: null, stage: stageBadge(offsetDay) };

  if (wantEmail) {
    const pool = await loadExperiencePool(campaign);
    // A real, flagged dispatch row — so every link in this mail is tracked
    // exactly as a live one would be, without touching the live numbers.
    const testRow = await testDispatchFor({
      campaign, offsetDay, userId: targetUserId, channel: 'email',
    });
    try {
      await sendOccasionGreeting({
        to: email,
        name,
        campaign,
        title: copy.title,
        message: copy.message,
        experiences: pool.slice(0, 3),
        offsetDay,
        // The real occurrence, so the "3 days to go · Diwali on 8 Nov 2026"
        // ribbon in a test says what it will say on the day.
        occurrenceDate: nextOccurrence(campaign, istDateKey()),
        trackToken: testRow ? makeTrackToken(testRow.id) : null,
        unsubToken: makeToken(0), // inert token — a test can't opt anyone out
      });
      result.email = {
        ok: true,
        to: email,
        tracked: !!testRow,
        // Said out loud, because an untracked test that looks identical to a
        // tracked one is how somebody concludes tracking is broken.
        note: testRow
          ? 'links and open pixel are tracked — tick “include test sends” in Analytics to watch it'
          : `no app account for ${email}, so this mail could not be tracked — sign in on the site with that address, or set an App user ID`,
      };
    } catch (err) {
      result.email = { ok: false, to: email, reason: err.message };
    }
  }

  if (wantPush) {
    if (!pushUserId) {
      result.push = {
        ok: false,
        reason: email
          ? `no app account signed in as ${email} — sign in on the phone with that address, or pass a userId`
          : 'no target account for the push',
      };
    } else {
      // sendPushToUser reports WHY nothing arrived (not configured / no device
      // token / dead token) instead of failing silently — that reason is the
      // whole value of a test button, so it is passed straight through.
      const r = await sendPushToUser(pushUserId, {
        title: copy.title,
        body: copy.message || campaign.name,
        data: {
          kind: 'campaign',
          campaignSlug: campaign.slug,
          ctaPath: campaign.ctaPath || '/experiences',
          test: '1',
        },
      });
      result.push = { ...r, userId: pushUserId };
    }
  }

  const parts = [
    result.email ? `email ${result.email.ok ? 'sent' : 'failed'}` : null,
    result.push ? `push ${result.push.ok ? 'sent' : 'failed'}` : null,
  ].filter(Boolean);
  return ok(res, { preview: copy, result }, `Test: ${parts.join(', ')}`);
});

// POST /api/admin/campaigns/run-now  { id?, date? } — force today's due waves.
const runNow = asyncHandler(async (req, res) => {
  const only = Number(req.body?.id) || null;
  const sendDate = DATE_RE.test(String(req.body?.date || '')) ? req.body.date : istDateKey();
  const report = await sweepOccasionCampaigns({ sendDate, force: true, only });
  return ok(res, report, 'Sweep complete');
});

// POST /api/admin/campaigns/seed — (re)load the shipped Indian calendar.
const seed = asyncHandler(async (req, res) => {
  const result = await seedCampaignCalendar({ force: !!req.body?.force, log: () => {} });
  return ok(res, result, `Seeded: ${result.created} new, ${result.updated} updated`);
});

/*
  GET /api/admin/campaigns/analytics?days=90&type=&campaignId=&channel=&offsetDay=

  What a wave actually did, as a funnel rather than a send count:

      sent → opened → clicked → explored an experience → booked

  Every step is measured and the honesty of each one differs, so the payload
  says which is which rather than letting the dashboard present them as peers:

    - sent      HARD. One dispatch row per person per channel.
    - opened    SOFT, email only. A tracking pixel — Gmail proxies images and
                Apple Mail Privacy Protection pre-fetches them, so this
                over-counts, sometimes badly. A trend, not a number.
    - clicked   HARD. Somebody tapped a link and reached the chooser.
    - explored  HARD, and the one that matters: they tapped a suggested
                EXPERIENCE, not the generic browse button.
    - booked    ATTRIBUTED, not proven. See below.

  ── The revenue number, and what it is not ────────────────────────────────

  A booking carries no campaign id — people click a greeting on Tuesday and
  book on Thursday from the home page. So revenue is attributed by WINDOW: a
  confirmed booking counts for a campaign when that same user clicked that
  campaign's link within ATTRIBUTION_DAYS before booking.

  That is last-touch attribution, and it is a claim rather than a fact: the
  customer might well have booked anyway. It is labelled "influenced"
  everywhere it is shown, for exactly that reason. What it is genuinely good
  for is COMPARISON — Diwali against Holi, the "-3" beat against the day-of
  one — because the same bias applies to every row equally.
*/
const ATTRIBUTION_DAYS = 7;

const analytics = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
  const since = addDaysToKey(istDateKey(), -days);

  /*
    Filters, all optional, all applied to the SAME base query — so every card,
    chart and table on the page describes one identical slice. A dashboard
    whose headline number disagrees with its own table is worse than a
    dashboard with fewer numbers on it.
  */
  const where = { occurrenceDate: { [Op.gte]: since } };
  if (Number(req.query.campaignId)) where.campaignEventId = Number(req.query.campaignId);
  if (['email', 'push', 'inapp'].includes(req.query.channel)) where.channel = req.query.channel;
  if (req.query.offsetDay !== undefined && req.query.offsetDay !== '') {
    const o = Number(req.query.offsetDay);
    if (Number.isInteger(o)) where.offsetDay = o;
  }

  /*
    Test sends are tracked exactly like real ones, and are excluded from every
    report by default — a handful of admin tests against a small base would
    otherwise dominate the rates. `includeTests` exists so an admin can watch
    their own test arrive, which is the entire point of testing.
  */
  const includeTests = req.query.includeTests === '1' || req.query.includeTests === 'true';
  if (!includeTests) where.isTest = false;

  const typeFilter = String(req.query.type || '');
  const campaignInclude = {
    model: CampaignEvent,
    as: 'campaign',
    attributes: ['id', 'name', 'slug', 'type'],
    required: !!typeFilter,
    where: typeFilter ? { type: typeFilter } : undefined,
  };

  // One pass over the dispatch rows is all the funnel needs; pulling them once
  // and folding in JS beats six GROUP BY round-trips to a remote database.
  const rows = await CampaignDispatch.findAll({
    where,
    include: [campaignInclude],
    attributes: [
      'id', 'campaignEventId', 'channel', 'status', 'offsetDay', 'occurrenceDate',
      'userId', 'sentAt', 'openedAt', 'clickedAt', 'clickCount', 'clickKind', 'clickVia',
    ],
    order: [['sentAt', 'DESC']],
    limit: 20000,
  });

  const blank = () => ({
    sent: 0,
    failed: 0,
    opened: 0,
    clicked: 0,
    landed: 0,
    explored: 0,
    clicks: 0,
    viaApp: 0,
    viaBrowser: 0,
    dwellTotal: 0,
    dwellCount: 0,
    people: new Set(),
  });

  const fold = (acc, r) => {
    if (r.status === 'failed') { acc.failed += 1; return acc; }
    acc.sent += 1;
    acc.people.add(r.userId);
    if (r.openedAt) acc.opened += 1;
    if (r.clickedAt) {
      acc.clicked += 1;
      acc.clicks += r.clickCount || 1;
      if (r.clickKind === 'experience') acc.explored += 1;
      if (r.clickVia === 'app') acc.viaApp += 1; else acc.viaBrowser += 1;
    }
    if (r.landedAt) acc.landed += 1;
    // Averaged over the people who reported a stay, not over everyone sent —
    // dividing by the whole audience would make the average meaningless.
    if (r.dwellSeconds > 0) { acc.dwellTotal += r.dwellSeconds; acc.dwellCount += 1; }
    return acc;
  };

  // Sets are how "people" stays a headcount rather than a message count; they
  // are collapsed to a size on the way out.
  const finish = (a) => {
    const { people, dwellTotal, dwellCount, ...rest } = a;
    return {
      ...rest,
      people: people.size,
      dwellCount,
      avgDwellSeconds: dwellCount ? Math.round(dwellTotal / dwellCount) : 0,
    };
  };

  const overall = blank();
  const byChannel = new Map();
  const byCampaign = new Map();
  const byBeat = new Map();
  const byDate = new Map();
  const clickedUsers = new Map(); // userId -> { at, campaignEventId } — for attribution

  for (const row of rows) {
    const r = row.toJSON();
    fold(overall, r);

    if (!byChannel.has(r.channel)) byChannel.set(r.channel, blank());
    fold(byChannel.get(r.channel), r);

    if (!byCampaign.has(r.campaignEventId)) {
      byCampaign.set(r.campaignEventId, {
        ...blank(),
        id: r.campaignEventId,
        name: (r.campaign && r.campaign.name) || '(deleted)',
        slug: (r.campaign && r.campaign.slug) || null,
        type: (r.campaign && r.campaign.type) || null,
      });
    }
    fold(byCampaign.get(r.campaignEventId), r);

    if (!byBeat.has(r.offsetDay)) byBeat.set(r.offsetDay, { ...blank(), offsetDay: r.offsetDay });
    fold(byBeat.get(r.offsetDay), r);

    if (!byDate.has(r.occurrenceDate)) byDate.set(r.occurrenceDate, { ...blank(), date: r.occurrenceDate });
    fold(byDate.get(r.occurrenceDate), r);

    // Earliest click wins the attribution — the message that first moved them.
    if (r.clickedAt) {
      const prev = clickedUsers.get(r.userId);
      if (!prev || new Date(r.clickedAt) < new Date(prev.at)) {
        clickedUsers.set(r.userId, { at: r.clickedAt, campaignEventId: r.campaignEventId });
      }
    }
  }

  /*
    Attributed revenue. ONE query for the bookings of everyone who clicked in
    this window, then matched back in JS — a per-campaign SQL join would be a
    correlated subquery per campaign against a remote database, for a number
    that is an estimate either way.
  */
  const attributed = { bookings: 0, revenuePaise: 0, byCampaign: new Map() };
  if (clickedUsers.size) {
    const userIds = [...clickedUsers.keys()];
    const earliestClick = [...clickedUsers.values()]
      .reduce((min, v) => (!min || new Date(v.at) < new Date(min) ? v.at : min), null);

    const bookings = await Booking.findAll({
      where: {
        userId: { [Op.in]: userIds },
        status: { [Op.in]: ['confirmed', 'completed'] },
        createdAt: { [Op.gte]: new Date(earliestClick) },
      },
      attributes: ['id', 'userId', 'totalPaise', 'createdAt'],
      limit: 5000,
    });

    const windowMs = ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000;
    for (const b of bookings) {
      const click = clickedUsers.get(b.userId);
      if (!click) continue;
      const gap = new Date(b.createdAt) - new Date(click.at);
      if (gap < 0 || gap > windowMs) continue;
      attributed.bookings += 1;
      attributed.revenuePaise += b.totalPaise || 0;
      const c = attributed.byCampaign.get(click.campaignEventId) || { bookings: 0, revenuePaise: 0 };
      c.bookings += 1;
      c.revenuePaise += b.totalPaise || 0;
      attributed.byCampaign.set(click.campaignEventId, c);
    }
  }

  // Audience health — who the engine can even reach, and on which channel.
  const [total, optedIn, withDob, withAnniversary, withPush] = await Promise.all([
    User.count({ where: { isActive: true } }),
    User.count({ where: { isActive: true, marketingOptOutAt: null } }),
    User.count({ where: { isActive: true, dob: { [Op.ne]: null } } }),
    User.count({ where: { isActive: true, anniversary: { [Op.ne]: null } } }),
    User.count({ where: { isActive: true, fcmToken: { [Op.ne]: null } } }),
  ]);

  const campaignRows = [...byCampaign.values()]
    .map((c) => ({
      ...finish(c),
      ...(attributed.byCampaign.get(c.id) || { bookings: 0, revenuePaise: 0 }),
    }))
    .sort((a, b) => b.sent - a.sent);

  const channels = {};
  for (const [name, acc] of byChannel) channels[name] = finish(acc);

  /*
    Tracking health, reported alongside the numbers.

    Zeroes across an engagement dashboard have two boring causes and one
    interesting one, and an admin cannot tell them apart by looking:

      1. the messages predate tracking — nothing was instrumented to report,
      2. APP_URL is unset on THIS server, so no pixel URL can be built and
         every mail goes out unmeasured however many are sent,
      3. people genuinely did not engage.

    Only the third is worth acting on, so the first two are stated outright
    rather than left to be discovered. `trackedSent` counts messages that
    actually carried tracking — a dispatch sent after the feature existed —
    approximated by the earliest row that ever recorded an open or a click.
  */
  // Reduced, not sorted: Array#sort on Date objects compares them as strings
  // ("Mon Aug 24 …"), which orders by weekday name. And it reads the folded
  // plain objects rather than the model instances, so the shape is the same
  // one every other number on this page was computed from.
  let trackedFrom = null;
  for (const row of rows) {
    const r = row.toJSON();
    if (!(r.openedAt || r.clickedAt || r.landedAt) || !r.sentAt) continue;
    if (!trackedFrom || new Date(r.sentAt) < new Date(trackedFrom)) trackedFrom = r.sentAt;
  }

  /*
    Test sends, counted SEPARATELY and always — even when this request excluded
    them from everything else.

    Without this the page could tell an outright lie. `rows` has already had
    test sends filtered out, so an admin who pressed Test, opened the mail and
    clicked it saw "nothing has been measured yet" — while their test had in
    fact been measured perfectly and was sitting one panel below. The most
    likely reason someone is looking at this screen is that they just tested,
    so that is precisely the case the page has to get right.
  */
  const testWhere = { occurrenceDate: { [Op.gte]: since }, isTest: true };
  const [testSent, testOpened, testClicked] = await Promise.all([
    CampaignDispatch.count({ where: testWhere }),
    CampaignDispatch.count({ where: { ...testWhere, openedAt: { [Op.ne]: null } } }),
    CampaignDispatch.count({ where: { ...testWhere, clickedAt: { [Op.ne]: null } } }),
  ]);

  return ok(res, {
    days,
    since,
    attributionDays: ATTRIBUTION_DAYS,
    includeTests,
    tests: { sent: testSent, opened: testOpened, clicked: testClicked },
    tracking: {
      // Without APP_URL there is no absolute URL to point a pixel at, so
      // campaignEmail.service emits none and every send is unmeasured.
      enabled: !!String(process.env.APP_URL || '').trim(),
      pixelBase: String(process.env.APP_URL || '').replace(/\/$/, ''),
      firstEngagementAt: trackedFrom,
    },
    filters: {
      type: typeFilter,
      campaignId: Number(req.query.campaignId) || null,
      channel: req.query.channel || '',
      offsetDay: req.query.offsetDay === undefined || req.query.offsetDay === ''
        ? null
        : Number(req.query.offsetDay),
    },
    funnel: {
      ...finish(overall),
      bookings: attributed.bookings,
      revenuePaise: attributed.revenuePaise,
    },
    channels,
    campaigns: campaignRows,
    beats: [...byBeat.values()].map(finish).sort((a, b) => a.offsetDay - b.offsetDay),
    timeline: [...byDate.values()].map(finish).sort((a, b) => (a.date < b.date ? -1 : 1)),
    audience: {
      total, optedIn, optedOut: total - optedIn, withDob, withAnniversary, withPush,
    },
    recent: rows.slice(0, 25).map((row) => {
      const j = row.toJSON();
      return {
        id: j.id,
        campaign: (j.campaign && j.campaign.name) || '(deleted)',
        channel: j.channel,
        status: j.status,
        offsetDay: j.offsetDay,
        occurrenceDate: j.occurrenceDate,
        sentAt: j.sentAt,
        openedAt: j.openedAt,
        clickedAt: j.clickedAt,
        clickKind: j.clickKind,
        clickVia: j.clickVia,
      };
    }),
  });
});

/*
  ── Engagement tracking (public, no auth, never fails loudly) ──────────────

  Two endpoints, both reached from a greeting email or the app-or-browser
  chooser, and both answering with a 1x1 GIF whatever happens. A tracking
  endpoint that can return an error is a broken image in somebody's inbox, so
  every failure path here — bad token, deleted dispatch, dead database — ends
  the same way: a transparent pixel and a 200.

  Nothing here trusts its input. The token is an HMAC over the dispatch id
  (utils/campaignTrackToken.js), so these URLs cannot be walked to inflate the
  numbers, and an unrecognised one is simply ignored.
*/
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

const sendPixel = (res) => {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL.length),
    // Proxies caching the pixel would silently stop counting opens.
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  });
  return res.status(200).end(PIXEL);
};

/*
  GET /api/campaigns/t/open.gif?t=<token>

  The email open pixel. Soft by design and labelled as such everywhere it is
  shown: Gmail proxies images and Apple Mail Privacy Protection pre-fetches
  them, so this over-counts. It is here because the SHAPE of the curve is
  still useful, not because the number is exact.

  Only the FIRST open is recorded. A second one is the same person scrolling
  past the mail again, and counting it would make "opens" drift away from
  "people".
*/
const trackOpen = asyncHandler(async (req, res) => {
  const id = readTrackToken(req.query.t);
  if (id) {
    try {
      await CampaignDispatch.update(
        { openedAt: new Date() },
        { where: { id, openedAt: null } }
      );
    } catch (err) {
      console.warn('[occasion] open tracking failed:', err.message);
    }
  }
  return sendPixel(res);
});

/*
  GET /api/campaigns/t/click.gif?t=<token>&k=experience|browse&via=app|browser

  Fired by the chooser page (frontend/public/open.html) — as an IMAGE, not a
  fetch, deliberately: the site and the API are on different origins, and an
  image request needs no CORS preflight, no credentials and no error handling
  on a page whose only job is to get out of the way.

  `clickedAt` keeps the FIRST click (when the campaign worked) while
  clickCount keeps every one. `clickKind` is only ever upgraded to
  'experience': someone who browsed and then opened an experience did explore
  one, and the reverse order should not downgrade them back to a browser.
*/
const trackClick = asyncHandler(async (req, res) => {
  const id = readTrackToken(req.query.t);
  if (id) {
    try {
      const row = await CampaignDispatch.findByPk(id);
      if (row) {
        const kind = req.query.k === 'experience' ? 'experience' : 'browse';
        const via = req.query.via === 'app' ? 'app' : 'browser';
        await row.update({
          clickedAt: row.clickedAt || new Date(),
          clickCount: (row.clickCount || 0) + 1,
          clickKind: row.clickKind === 'experience' ? 'experience' : kind,
          clickVia: via,
        });
      }
    } catch (err) {
      console.warn('[occasion] click tracking failed:', err.message);
    }
  }
  return sendPixel(res);
});

/*
  GET /api/admin/campaigns/recipients?days=&campaignId=&channel=&offsetDay=&state=&page=

  The named list behind every percentage on the analytics page.

  A rate answers "did it work"; it never answers "who". This does — one row
  per person per message, with what they did and when, so an admin can pull up
  the twelve people a Diwali mail actually moved instead of reading 4.7% and
  guessing. `state` is the same funnel as the chart, used as a filter:

      opened | clicked | explored | landed | booked | nothing

  Attribution is computed here rather than cached on the row. Caching it would
  freeze the answer at whatever ATTRIBUTION_DAYS was on the day it ran, and
  the window is exactly the sort of thing that gets tuned — a stored number
  would quietly stop matching the dashboard above it.
*/
const recipients = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
  const since = addDaysToKey(istDateKey(), -days);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const perPage = 50;

  const where = { occurrenceDate: { [Op.gte]: since } };
  if (Number(req.query.campaignId)) where.campaignEventId = Number(req.query.campaignId);
  if (['email', 'push', 'inapp'].includes(req.query.channel)) where.channel = req.query.channel;
  if (req.query.offsetDay !== undefined && req.query.offsetDay !== '') {
    const o = Number(req.query.offsetDay);
    if (Number.isInteger(o)) where.offsetDay = o;
  }

  // The funnel filters are all "this column is set", which keeps them
  // expressible in SQL rather than pulling everything back to filter in JS.
  /*
    Three modes, not two. Reports normally hide test sends so a handful of
    admin tests cannot move the rates; `includeTests` folds them back in; and
    `tests=only` shows nothing else — which is what the Test sends panel asks
    for, so an admin can audit exactly what they fired, at what, and what came
    back, without that audit ever touching the live numbers.
  */
  if (req.query.tests === 'only') where.isTest = true;
  else if (!(req.query.includeTests === '1' || req.query.includeTests === 'true')) where.isTest = false;

  const state = String(req.query.state || '');
  if (state === 'opened') where.openedAt = { [Op.ne]: null };
  if (state === 'clicked') where.clickedAt = { [Op.ne]: null };
  if (state === 'landed') where.landedAt = { [Op.ne]: null };
  if (state === 'explored') where.clickKind = 'experience';
  if (state === 'nothing') { where.openedAt = null; where.clickedAt = null; }

  const { rows, count } = await CampaignDispatch.findAndCountAll({
    where,
    include: [
      { model: CampaignEvent, as: 'campaign', attributes: ['id', 'name', 'slug', 'type'] },
    ],
    attributes: [
      'id', 'campaignEventId', 'userId', 'channel', 'status', 'offsetDay', 'occurrenceDate',
      'sentAt', 'openedAt', 'clickedAt', 'clickCount', 'clickKind', 'clickVia',
      'landedAt', 'dwellSeconds', 'isTest',
    ],
    // Most engaged first: the people who did something are the point of the
    // list, and burying them under a thousand "delivered, nothing" rows would
    // make the page useless at exactly the size where it starts to matter.
    order: [
      [literal('clickedAt IS NULL'), 'ASC'],
      ['clickedAt', 'DESC'],
      [literal('openedAt IS NULL'), 'ASC'],
      ['sentAt', 'DESC'],
    ],
    limit: perPage,
    offset: (page - 1) * perPage,
  });

  // Names/emails in one query rather than a join per row.
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const users = userIds.length
    ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'name', 'email', 'city'] })
    : [];
  const userById = new Map(users.map((u) => [u.id, u.toJSON()]));

  /*
    Bookings for the people on THIS page only, matched back against each
    person's own click. Scoped to the page because the list is paginated and
    the alternative — every booking by every clicker in the window — is a far
    larger query for rows nobody is looking at.
  */
  const clickers = rows.filter((r) => r.clickedAt);
  let bookingByUser = new Map();
  if (clickers.length) {
    const earliest = clickers
      .map((r) => new Date(r.clickedAt))
      .reduce((a, b) => (a < b ? a : b));
    const bookings = await Booking.findAll({
      where: {
        userId: { [Op.in]: clickers.map((r) => r.userId) },
        status: { [Op.in]: ['confirmed', 'completed'] },
        createdAt: { [Op.gte]: earliest },
      },
      attributes: ['id', 'bookingCode', 'userId', 'totalPaise', 'createdAt'],
      limit: 2000,
    });
    const windowMs = ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000;
    for (const b of bookings) {
      const own = clickers.filter((r) => r.userId === b.userId);
      for (const r of own) {
        const gap = new Date(b.createdAt) - new Date(r.clickedAt);
        if (gap < 0 || gap > windowMs) continue;
        const prev = bookingByUser.get(r.id);
        if (!prev || new Date(b.createdAt) < new Date(prev.createdAt)) {
          bookingByUser.set(r.id, b.toJSON());
        }
      }
    }
  }

  const items = rows.map((row) => {
    const j = row.toJSON();
    const u = userById.get(j.userId) || {};
    const booking = bookingByUser.get(j.id) || null;
    return {
      id: j.id,
      user: {
        id: j.userId, name: u.name || `User #${j.userId}`, email: u.email || null, city: u.city || null,
      },
      campaign: (j.campaign && j.campaign.name) || '(deleted)',
      campaignId: j.campaignEventId,
      channel: j.channel,
      status: j.status,
      offsetDay: j.offsetDay,
      occurrenceDate: j.occurrenceDate,
      sentAt: j.sentAt,
      openedAt: j.openedAt,
      clickedAt: j.clickedAt,
      clickCount: j.clickCount,
      clickKind: j.clickKind,
      clickVia: j.clickVia,
      landedAt: j.landedAt,
      dwellSeconds: j.dwellSeconds,
      isTest: !!j.isTest,
      booking: booking
        ? { code: booking.bookingCode, paise: booking.totalPaise, at: booking.createdAt }
        : null,
    };
  });

  return ok(res, {
    items,
    page,
    perPage,
    total: count,
    pages: Math.max(Math.ceil(count / perPage), 1),
    attributionDays: ATTRIBUTION_DAYS,
  });
});

/*
  GET /api/campaigns/t/land.gif?t=<token>

  The site confirming the page actually rendered.

  A click and a visit are not the same event, and the gap between them is
  worth seeing: a phone that opened the chooser and then lost signal counts as
  a click and never as a landing. This is fired by the website once the
  destination page has mounted, so "clicked 40, landed 31" is a real and
  actionable difference rather than a rounding error.
*/
const trackLand = asyncHandler(async (req, res) => {
  const id = readTrackToken(req.query.t);
  if (id) {
    try {
      await CampaignDispatch.update(
        { landedAt: new Date() },
        { where: { id, landedAt: null } }
      );
    } catch (err) {
      console.warn('[occasion] land tracking failed:', err.message);
    }
  }
  return sendPixel(res);
});

/*
  GET|POST /api/campaigns/t/dwell?t=<token>&s=<seconds>

  How long they stayed, reported by the page as it goes away.

  POST exists because that is what navigator.sendBeacon sends, and sendBeacon
  is the only thing a browser reliably delivers during unload — an <img> fired
  at that moment is frequently cancelled. Everything travels in the query
  string, so the beacon needs no body and no content-type negotiation, which
  keeps it a "simple" cross-origin request with no preflight.

  DWELL_CAP_SECONDS is not tidiness. A tab left open overnight reports 40,000
  seconds, and a single row like that moves an average more than a hundred
  honest ones — the cap is what keeps "average time on page" a number anybody
  can act on. The LONGEST reading wins, because a page can report several
  times (tab hidden, then closed) and the last report is not the largest.
*/
const DWELL_CAP_SECONDS = 30 * 60;

const trackDwell = asyncHandler(async (req, res) => {
  const id = readTrackToken(req.query.t);
  const seconds = Math.min(Math.max(Math.round(Number(req.query.s) || 0), 0), DWELL_CAP_SECONDS);
  if (id && seconds > 0) {
    try {
      const row = await CampaignDispatch.findByPk(id);
      if (row && seconds > (row.dwellSeconds || 0)) {
        await row.update({ dwellSeconds: seconds, landedAt: row.landedAt || new Date() });
      }
    } catch (err) {
      console.warn('[occasion] dwell tracking failed:', err.message);
    }
  }
  return sendPixel(res);
});

/*
  GET|POST /api/campaigns/unsubscribe?token=…  (public, no auth)
  One-click opt-out from the footer of every greeting email.
*/
const unsubscribe = asyncHandler(async (req, res) => {
  const token = req.query.token || req.body?.token;
  const userId = readToken(token);
  if (!userId) return fail(res, 'This unsubscribe link is not valid', 400);
  const user = await User.findByPk(userId);
  if (!user) return fail(res, 'Account not found', 404);
  if (!user.marketingOptOutAt) await user.update({ marketingOptOutAt: new Date() });
  return ok(res, { email: user.email }, 'You will no longer receive occasion greetings.');
});

// POST /api/campaigns/resubscribe — signed-in undo for the above.
const resubscribe = asyncHandler(async (req, res) => {
  await User.update({ marketingOptOutAt: null }, { where: { id: req.user.id } });
  return ok(res, {}, 'Greetings turned back on');
});

module.exports = {
  list,
  upcomingSchedule,
  create,
  update,
  toggle,
  verifyDates,
  remove,
  test,
  runNow,
  seed,
  analytics,
  unsubscribe,
  resubscribe,
  recipients,
  trackOpen,
  trackClick,
  trackLand,
  trackDwell,
};

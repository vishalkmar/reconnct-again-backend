const asyncHandler = require('express-async-handler');
const { Op, fn, col, literal } = require('sequelize');
const {
  CampaignEvent, CampaignDispatch, User,
} = require('../models');
const { ok, created, fail } = require('../utils/response');
const { istDateKey, prettyKey, addDaysToKey } = require('../utils/istDate');
const {
  upcoming, nextOccurrence, normaliseOffsets, normaliseChannels, renderCopy,
} = require('../services/campaignCalendar.service');
const { sweepOccasionCampaigns, loadExperiencePool } = require('../services/campaignSweep.service');
const { sendOccasionGreeting } = require('../services/campaignEmail.service');
const { sendPushToUser } = require('../services/push.service');
const {
  applyCountdown, isOnCountdown, isCountdownCampaign, COUNTDOWN_OFFSETS, stageBadge,
} = require('../services/campaignCountdown.service');
const { seedCampaignCalendar } = require('../seeders/seedCampaignCalendar');
const { makeToken, readToken } = require('../utils/unsubscribeToken');

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
      // Is this occasion running the full seven-day run-up, and could it?
      onCountdown: isOnCountdown(json),
      canCountdown: isCountdownCampaign(json),
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

  let pushUserId = Number(req.body?.userId) || null;
  if (wantPush && !pushUserId && email) {
    // The app account that owns this address — that is the phone the admin is
    // holding, which is the phone they want the test to land on.
    const target = await User.findOne({ where: { email }, attributes: ['id', 'fcmToken'] });
    pushUserId = target ? target.id : null;
  }
  if (!wantEmail && !wantPush) return fail(res, 'Nothing to test — pick email, push, or both', 400);

  const copy = renderCopy(campaign, offsetDay, { name });
  const result = { email: null, push: null, stage: stageBadge(offsetDay) };

  if (wantEmail) {
    const pool = await loadExperiencePool(campaign);
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
        unsubToken: makeToken(0), // inert token — a test can't opt anyone out
      });
      result.email = { ok: true, to: email };
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

/*
  POST /api/admin/campaigns/apply-countdown  { scope?, ids? }

  Puts existing occasions onto the seven-day run-up (-7 / -3 / -2 / -1 / 0).

  The seeder already ships the ramp, but seeding is idempotent by slug and
  deliberately never overwrites a stored row — so a calendar that was loaded
  before the countdown existed would keep its old two-beat schedule forever.
  This is the migration for that, as a button rather than a script the admin
  cannot run.

  scope 'emailing' (default) upgrades the occasions that already email — the
  big ones. scope 'all' also sweeps in the minor push-only festivals, which
  is a real choice: it is five more sends per occasion across ~30 more
  occasions. Hand-written per-offset copy is never touched either way.
*/
const applyCountdownToAll = asyncHandler(async (req, res) => {
  const scope = req.body?.scope === 'all' ? 'all' : 'emailing';
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;

  const rows = await CampaignEvent.findAll(ids ? { where: { id: { [Op.in]: ids } } } : {});
  const changed = [];
  let skipped = 0;

  for (const row of rows) {
    const json = row.toJSON();
    // A per-campaign apply (ids given) is an explicit choice, so it ignores
    // the emailing/push-only distinction the bulk default draws.
    const ramp = applyCountdown(json, { scope: ids ? 'all' : scope });
    if (!ramp) { skipped += 1; continue; }
    if (isOnCountdown(json)) { skipped += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    await row.update(ramp);
    changed.push({ id: json.id, name: json.name, channels: json.channels });
  }

  return ok(
    res,
    { updated: changed.length, skipped, campaigns: changed, offsets: COUNTDOWN_OFFSETS },
    changed.length
      ? `${changed.length} occasion(s) now run the 7-day countdown`
      : 'Everything eligible is already on the countdown'
  );
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
  GET /api/admin/campaigns/analytics?days=90
  Reach and delivery, split by channel — the honest version: an email counted
  here is one we handed to the SMTP server, not one that was opened.
*/
const analytics = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
  const since = addDaysToKey(istDateKey(), -days);

  const [byChannel, byCampaign, audience, recent] = await Promise.all([
    CampaignDispatch.findAll({
      attributes: ['channel', 'status', [fn('COUNT', col('id')), 'n']],
      where: { occurrenceDate: { [Op.gte]: since } },
      group: ['channel', 'status'],
      raw: true,
    }),
    CampaignDispatch.findAll({
      attributes: [
        'campaignEventId',
        [fn('COUNT', col('CampaignDispatch.id')), 'n'],
        [fn('COUNT', fn('DISTINCT', col('userId'))), 'people'],
      ],
      where: { occurrenceDate: { [Op.gte]: since } },
      include: [{ model: CampaignEvent, as: 'campaign', attributes: ['name', 'slug', 'type'] }],
      group: ['campaignEventId', 'campaign.id'],
      order: [[literal('n'), 'DESC']],
      limit: 20,
    }),
    Promise.all([
      User.count({ where: { isActive: true } }),
      User.count({ where: { isActive: true, marketingOptOutAt: null } }),
      User.count({ where: { isActive: true, dob: { [Op.ne]: null } } }),
      User.count({ where: { isActive: true, anniversary: { [Op.ne]: null } } }),
      User.count({ where: { isActive: true, fcmToken: { [Op.ne]: null } } }),
    ]),
    CampaignDispatch.findAll({
      where: { occurrenceDate: { [Op.gte]: since } },
      include: [{ model: CampaignEvent, as: 'campaign', attributes: ['name', 'slug'] }],
      order: [['sentAt', 'DESC']],
      limit: 25,
    }),
  ]);

  const channels = {};
  for (const r of byChannel) {
    channels[r.channel] = channels[r.channel] || { sent: 0, failed: 0 };
    channels[r.channel][r.status === 'failed' ? 'failed' : 'sent'] += Number(r.n);
  }

  const [total, optedIn, withDob, withAnniversary, withPush] = audience;

  return ok(res, {
    days,
    since,
    channels,
    campaigns: byCampaign.map((r) => {
      const j = r.toJSON();
      return {
        campaignEventId: j.campaignEventId,
        name: j.campaign?.name || '(deleted)',
        slug: j.campaign?.slug || null,
        type: j.campaign?.type || null,
        messages: Number(j.n),
        people: Number(j.people),
      };
    }),
    audience: {
      total, optedIn, optedOut: total - optedIn, withDob, withAnniversary, withPush,
    },
    recent: recent.map((r) => {
      const j = r.toJSON();
      return {
        id: j.id,
        campaign: j.campaign?.name || '(deleted)',
        channel: j.channel,
        status: j.status,
        error: j.error,
        occurrenceDate: j.occurrenceDate,
        offsetDay: j.offsetDay,
        sentAt: j.sentAt,
      };
    }),
  });
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
  applyCountdownToAll,
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
};

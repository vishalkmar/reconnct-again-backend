/* eslint-disable no-console */
require('dotenv').config();
const { sequelize, CampaignEvent } = require('../models');

/*
  The occasion calendar, seeded once.

  Why a seed file and not a holiday API call at runtime:

    - Indian festivals follow the lunar calendar, so their dates move — but
      they are PUBLISHED years in advance. There is nothing to "look up live".
    - An API can tell you 8 Nov 2026 is Diwali. It cannot tell you which
      banner to use, what the message should say, or which experiences to
      suggest. That is the actual work, and it is human work.
    - A live third-party dependency in the send path is a new way for the
      Diwali wave to silently not happen.

  So: dates live in our DB, editable from Admin → Occasion Marketing.

  FOUR GROUPS BELOW, and the difference between them matters:

    1. FIXED       — same date every year (26 Jan, 14 Feb, 25 Dec). Stored as
                     month+day and computed forever. Zero maintenance.
    2. RULE-BASED  — no fixed date but a fixed RULE: Mother's Day is the 2nd
                     Sunday of May, Father's Day the 3rd Sunday of June,
                     Friendship Day the 1st Sunday of August. Computed from
                     the rule, so these are also zero maintenance forever.
    3. VARIABLE    — lunar festivals. Real dates only, one line per year, and
                     every one carries needsDateCheck: true. The 2026 dates
                     here are the ones supplied for this build; the later
                     years are best-known values and MUST be confirmed against
                     a panchang before that season. Greeting people on the
                     wrong day is worse than not greeting them at all.
    4. PERSONAL    — each user's own birthday / anniversary, from their profile.

  EMAIL vs PUSH: every occasion sends the free in-app + push notification —
  81 of those a year, which is fine because they are silent and stack in one
  bell. EMAIL is rationed instead: Rose Day does not need to be an email,
  Diwali does. As seeded that works out to 33 marketing emails per person per
  year (plus their birthday and anniversary), and the day-before wave is
  push-only for everything except the six occasions listed in
  DAY_BEFORE_EMAIL at the bottom of this file. Every one of those decisions is
  a channel checkbox in the admin, not a code change.
*/

// Channel presets — the policy above, in one place.
const ALL = ['email', 'push', 'inapp']; // big occasions
const LIGHT = ['push', 'inapp']; // minor / high-frequency ones (no email)

const CAMPAIGNS = [
  // ═══ 1. FIXED DATES — same day every year ════════════════════════════════
  {
    slug: 'new-year',
    name: 'New Year',
    type: 'holiday',
    recurrence: 'yearly_fixed',
    month: 1,
    day: 1,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy New Year, {{name}}!',
    message: 'A new year of places you have not been yet. Start it with one.',
    ctaPath: '/experiences?occasion=new-year',
    suggestKeywords: ['trek', 'camp', 'adventure'],
  },
  {
    slug: 'national-youth-day',
    name: 'National Youth Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 1,
    day: 12,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy National Youth Day, {{name}}!',
    message: 'Go do something your future self will brag about.',
    ctaPath: '/experiences?occasion=youth-day',
    suggestKeywords: ['adventure', 'trek', 'rafting', 'bungee'],
  },
  {
    slug: 'republic-day',
    name: 'Republic Day',
    type: 'holiday',
    recurrence: 'yearly_fixed',
    month: 1,
    day: 26,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Republic Day, {{name}}!',
    message: 'A long weekend worth using. Treks, camps and getaways with slots still open.',
    ctaPath: '/experiences?occasion=republic-day',
    suggestKeywords: ['weekend', 'camp', 'trek'],
  },

  // ── Valentine week: 7 fixed days, each its own occasion ──────────────────
  // Seven emails in seven days would be punishing, so the week runs on push +
  // the in-app bell only. Valentine's Day itself (below) gets the email.
  {
    slug: 'rose-day',
    name: 'Rose Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 7,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Rose Day, {{name}} 🌹',
    message: 'Valentine week starts today — and the good couple spots book out first.',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic', 'candle'],
  },
  {
    slug: 'propose-day',
    name: 'Propose Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 8,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Propose Day, {{name}} 💍',
    message: 'Ask somewhere they will never forget — a cliff, a lake, a hot-air balloon.',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic', 'balloon', 'sunset'],
  },
  {
    slug: 'chocolate-day',
    name: 'Chocolate Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 9,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Chocolate Day, {{name}} 🍫',
    message: 'Sweeter than chocolate: a weekend away together.',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic', 'stay'],
  },
  {
    slug: 'teddy-day',
    name: 'Teddy Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 10,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Teddy Day, {{name}} 🧸',
    message: 'Gift something that outlasts a soft toy.',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic'],
  },
  {
    slug: 'promise-day',
    name: 'Promise Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 11,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Promise Day, {{name}} 🤝',
    message: 'Promise them the trip you keep postponing. Then actually book it.',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'getaway', 'trip'],
  },
  {
    slug: 'hug-day',
    name: 'Hug Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 12,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Hug Day, {{name}} 🤗',
    message: 'Cold mornings, warm bonfires. Couple escapes near you.',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'bonfire', 'romantic'],
  },
  {
    slug: 'kiss-day',
    name: 'Kiss Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 13,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Kiss Day, {{name}} 💋',
    message: "Valentine's is tomorrow — the couple getaways still open are going fast.",
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic', 'getaway'],
  },
  {
    slug: 'valentines-day',
    name: "Valentine's Day",
    type: 'festival',
    recurrence: 'yearly_fixed',
    month: 2,
    day: 14,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: "Happy Valentine's Day, {{name}}! ❤️",
    message: 'Dinner is fine. A sunrise trek, a lakeside camp or a hot-air balloon is better.',
    offsetCopy: {
      '-1': {
        title: "Valentine's is tomorrow, {{name}}",
        message: 'Still no plan? These couple experiences have slots for tomorrow.',
      },
    },
    ctaLabel: 'See couple experiences',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic', 'candle', 'sunset'],
  },

  {
    slug: 'womens-day',
    name: "International Women's Day",
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 3,
    day: 8,
    sendOffsets: [0],
    channels: ALL,
    title: "Happy Women's Day, {{name}}!",
    message: 'Solo trips, all-women treks and girls-only getaways — go take up space.',
    ctaPath: '/experiences?occasion=womens-day',
    suggestKeywords: ['women', 'solo', 'trek', 'getaway'],
  },
  {
    slug: 'siblings-day',
    name: 'Siblings Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 4,
    day: 10,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Siblings Day, {{name}}!',
    message: 'Settle the old argument on a rafting trip instead.',
    ctaPath: '/experiences?audience=friends',
    suggestKeywords: ['rafting', 'adventure', 'group'],
  },
  {
    slug: 'baisakhi-ambedkar-jayanti',
    name: 'Baisakhi & Ambedkar Jayanti',
    type: 'holiday',
    recurrence: 'yearly_fixed',
    month: 4,
    day: 14,
    sendOffsets: [-1, 0],
    channels: ALL,
    // Two occasions share 14 April. One campaign, one message — nobody wants
    // two notifications on the same morning.
    title: 'Happy Baisakhi, {{name}}!',
    message: 'A holiday, harvest season and the hills just waking up.',
    ctaPath: '/experiences?occasion=baisakhi',
    suggestKeywords: ['weekend', 'trek', 'camp'],
  },
  {
    slug: 'earth-day',
    name: 'Earth Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 4,
    day: 22,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Earth Day, {{name}} 🌍',
    message: 'The best way to care about a place is to go stand in it.',
    ctaPath: '/experiences?occasion=earth-day',
    suggestKeywords: ['nature', 'eco', 'forest', 'wildlife', 'trek'],
  },
  {
    slug: 'labour-day',
    name: 'Labour Day',
    type: 'holiday',
    recurrence: 'yearly_fixed',
    month: 5,
    day: 1,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Labour Day, {{name}}!',
    message: 'You have earned the day off. Spend it somewhere good.',
    ctaPath: '/experiences?occasion=labour-day',
    suggestKeywords: ['weekend', 'getaway', 'camp'],
  },
  {
    slug: 'family-day',
    name: 'International Day of Families',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 5,
    day: 15,
    sendOffsets: [0],
    channels: ALL,
    title: 'Happy Family Day, {{name}}!',
    message: 'Take the whole lot somewhere — family-friendly trips and day-outs.',
    ctaPath: '/experiences?audience=family',
    suggestKeywords: ['family', 'kids', 'picnic', 'resort'],
  },
  {
    slug: 'world-bicycle-day',
    name: 'World Bicycle Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 6,
    day: 3,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy World Bicycle Day, {{name}} 🚲',
    message: 'Two wheels, no engine. Cycling trails and rides near you.',
    ctaPath: '/experiences?occasion=cycling',
    suggestKeywords: ['cycl', 'bike ride', 'mtb'],
  },
  {
    slug: 'environment-day',
    name: 'World Environment Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 6,
    day: 5,
    sendOffsets: [0],
    channels: ALL,
    title: 'Happy Environment Day, {{name}} 🌱',
    message: 'Trek it, camp in it, leave it cleaner than you found it.',
    ctaPath: '/experiences?occasion=environment-day',
    suggestKeywords: ['trek', 'camp', 'nature', 'forest'],
  },
  {
    slug: 'yoga-day',
    name: 'International Yoga Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 6,
    day: 21,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Yoga Day, {{name}} 🧘',
    message: 'Sunrise on a mountain beats a mat in a living room.',
    ctaPath: '/experiences?occasion=yoga-day',
    suggestKeywords: ['yoga', 'wellness', 'retreat', 'meditation'],
  },
  {
    slug: 'international-youth-day',
    name: 'International Youth Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 8,
    day: 12,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Youth Day, {{name}}!',
    message: 'Adventure offers built for people with more time than money.',
    ctaPath: '/experiences?occasion=youth-day',
    suggestKeywords: ['adventure', 'trek', 'rafting', 'hostel'],
  },
  {
    slug: 'independence-day',
    name: 'Independence Day',
    type: 'holiday',
    recurrence: 'yearly_fixed',
    month: 8,
    day: 15,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Independence Day, {{name}}!',
    message: 'Monsoon treks, waterfall trails and a long weekend to spend on them.',
    ctaPath: '/experiences?occasion=independence-day',
    suggestKeywords: ['trek', 'waterfall', 'weekend', 'camp'],
  },
  {
    slug: 'photography-day',
    name: 'World Photography Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 8,
    day: 19,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Photography Day, {{name}} 📷',
    message: 'Places worth the camera roll — sunrise points, old towns, wildlife trails.',
    ctaPath: '/experiences?occasion=photography',
    suggestKeywords: ['photo', 'sunrise', 'wildlife', 'heritage'],
  },
  {
    slug: 'teachers-day',
    name: "Teachers' Day",
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 9,
    day: 5,
    sendOffsets: [0],
    channels: LIGHT,
    title: "Happy Teachers' Day, {{name}}!",
    message: 'A getaway for the people who never get one.',
    ctaPath: '/experiences?occasion=teachers-day',
    suggestKeywords: ['getaway', 'retreat', 'weekend'],
  },
  {
    slug: 'hindi-diwas',
    name: 'Hindi Diwas',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 9,
    day: 14,
    sendOffsets: [0],
    channels: LIGHT,
    // Seeded paused — it was marked optional. Flip it on from the admin page
    // if it turns out to fit the brand.
    isActive: false,
    title: 'Hindi Diwas ki shubhkamnayein, {{name}}!',
    message: 'Apne desh ko ghoomne se behtar kuch nahi.',
    ctaPath: '/experiences',
    suggestKeywords: ['heritage', 'culture'],
  },
  {
    slug: 'engineers-day',
    name: "Engineers' Day",
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 9,
    day: 15,
    sendOffsets: [0],
    channels: LIGHT,
    title: "Happy Engineers' Day, {{name}}!",
    message: 'Step away from the screen. Corporate offsites and weekend adventures.',
    ctaPath: '/experiences?occasion=engineers-day',
    suggestKeywords: ['corporate', 'team', 'offsite', 'adventure'],
  },
  {
    slug: 'world-tourism-day',
    name: 'World Tourism Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 9,
    day: 27,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'It is World Tourism Day, {{name}} ✈️',
    message: 'One day a year to admit you have been putting that trip off. Our biggest adventure line-up of the season is live.',
    ctaPath: '/experiences?occasion=world-tourism-day',
    suggestKeywords: ['adventure', 'trek', 'trip', 'tour'],
  },
  {
    slug: 'gandhi-jayanti',
    name: 'Gandhi Jayanti',
    type: 'holiday',
    recurrence: 'yearly_fixed',
    month: 10,
    day: 2,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Gandhi Jayanti, {{name}}',
    message: 'A holiday, good weather, and somewhere close by worth seeing.',
    ctaPath: '/experiences?occasion=gandhi-jayanti',
    suggestKeywords: ['weekend', 'heritage', 'trek'],
  },
  {
    slug: 'halloween',
    name: 'Halloween',
    type: 'festival',
    recurrence: 'yearly_fixed',
    month: 10,
    day: 31,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Halloween, {{name}} 🎃',
    message: 'Night camping, spooky trails and bonfires after dark.',
    ctaPath: '/experiences?occasion=halloween',
    suggestKeywords: ['night', 'camp', 'bonfire', 'fort'],
  },
  {
    slug: 'childrens-day',
    name: "Children's Day",
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 11,
    day: 14,
    sendOffsets: [0],
    channels: ALL,
    title: "Happy Children's Day, {{name}}!",
    message: 'Kid-friendly adventures — zip lines, nature trails and day camps.',
    ctaPath: '/experiences?audience=family',
    suggestKeywords: ['family', 'kids', 'zip', 'adventure park'],
  },
  {
    slug: 'mens-day',
    name: "International Men's Day",
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 11,
    day: 19,
    sendOffsets: [0],
    channels: LIGHT,
    title: "Happy Men's Day, {{name}}!",
    message: 'Round up the boys. Treks, rides and camps built for a group.',
    ctaPath: '/experiences?audience=friends',
    suggestKeywords: ['group', 'trek', 'ride', 'camp'],
  },
  {
    slug: 'mountain-day',
    name: 'International Mountain Day',
    type: 'awareness',
    recurrence: 'yearly_fixed',
    month: 12,
    day: 11,
    sendOffsets: [0],
    channels: ALL,
    title: 'Happy Mountain Day, {{name}} ⛰️',
    message: 'Snow line season. High-altitude treks and mountain stays are open.',
    ctaPath: '/experiences?occasion=mountain-day',
    suggestKeywords: ['mountain', 'trek', 'himalaya', 'snow'],
  },
  {
    slug: 'christmas',
    name: 'Christmas',
    type: 'festival',
    recurrence: 'yearly_fixed',
    month: 12,
    day: 25,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Merry Christmas, {{name}}! 🎄',
    message: 'Snow, bonfires and year-end camps — the best week of the year to be outside.',
    offsetCopy: {
      '-1': {
        title: 'Christmas eve, {{name}} 🎄',
        message: 'Last-minute plans that still have slots for tomorrow.',
      },
    },
    ctaPath: '/experiences?occasion=christmas',
    suggestKeywords: ['snow', 'camp', 'bonfire', 'resort'],
  },
  {
    slug: 'new-years-eve',
    name: "New Year's Eve",
    type: 'festival',
    recurrence: 'yearly_fixed',
    month: 12,
    day: 31,
    sendOffsets: [-3, -1, 0],
    channels: ALL,
    title: "Happy New Year's Eve, {{name}}! 🎉",
    message: 'Camp under the stars instead of queueing outside a club. NYE camps, parties and bonfires.',
    offsetCopy: {
      '-3': {
        title: 'NYE plans sorted, {{name}}?',
        message: 'New Year camps and parties fill up this week — here is what is still open.',
      },
    },
    ctaPath: '/experiences?occasion=new-year-eve',
    suggestKeywords: ['new year', 'party', 'camp', 'bonfire'],
  },

  // ═══ 2. RULE-BASED — no fixed date, but a fixed rule ═════════════════════
  // These are computed forever. Nobody has to re-enter them each year, and
  // they can never drift the way a hand-typed date list can.
  {
    slug: 'mothers-day',
    name: "Mother's Day",
    type: 'awareness',
    recurrence: 'nth_weekday',
    month: 5,
    weekday: 0, // Sunday
    nthWeek: 2, // 2nd Sunday of May
    sendOffsets: [-1, 0],
    channels: ALL,
    title: "Happy Mother's Day, {{name}}! 💐",
    message: 'She does not want another gift. Take her somewhere instead.',
    offsetCopy: {
      '-1': {
        title: "Mother's Day is tomorrow, {{name}}",
        message: 'Still deciding? These are bookable for tomorrow.',
      },
    },
    ctaPath: '/experiences?audience=family',
    suggestKeywords: ['family', 'resort', 'retreat', 'wellness'],
  },
  {
    slug: 'fathers-day',
    name: "Father's Day",
    type: 'awareness',
    recurrence: 'nth_weekday',
    month: 6,
    weekday: 0,
    nthWeek: 3, // 3rd Sunday of June
    sendOffsets: [-1, 0],
    channels: ALL,
    title: "Happy Father's Day, {{name}}!",
    message: 'Skip the shirt. Take him fishing, trekking, or on the drive he keeps talking about.',
    ctaPath: '/experiences?audience=family',
    suggestKeywords: ['family', 'fishing', 'trek', 'drive', 'camp'],
  },
  {
    slug: 'friendship-day',
    name: 'Friendship Day',
    type: 'awareness',
    recurrence: 'nth_weekday',
    month: 8,
    weekday: 0,
    nthWeek: 1, // 1st Sunday of August
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Friendship Day, {{name}}!',
    message: 'Get the group together. Group treks, camps and adventure days.',
    ctaPath: '/experiences?audience=friends',
    suggestKeywords: ['group', 'friends', 'trek', 'camp', 'rafting'],
  },

  // ═══ 3. VARIABLE — lunar dates. VERIFY BEFORE THE SEASON ════════════════
  // Every entry here is needsDateCheck: true. First date in each list is the
  // 2026 date supplied for this build; anything after it is a best-known
  // value that a human must confirm.
  {
    slug: 'lohri',
    name: 'Lohri',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-01-13', '2027-01-13', '2028-01-13'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Lohri, {{name}}! 🔥',
    message: 'Bonfire season. Winter camps and mountain stays are at their best.',
    ctaPath: '/experiences?occasion=lohri',
    suggestKeywords: ['bonfire', 'camp', 'winter', 'snow'],
  },
  {
    slug: 'makar-sankranti',
    name: 'Makar Sankranti / Pongal',
    type: 'festival',
    recurrence: 'dates',
    // Solar, so it barely moves — but it DOES move (14th/15th), which is
    // exactly why it is a date list and not a permanent month+day.
    occurrences: ['2026-01-14', '2027-01-14', '2028-01-14'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: LIGHT,
    title: 'Happy Makar Sankranti, {{name}}!',
    message: 'Kite season, bonfires and the first good weather of the year.',
    ctaPath: '/experiences?occasion=sankranti',
    suggestKeywords: ['kite', 'camp', 'trek', 'weekend'],
  },
  {
    slug: 'basant-panchami',
    name: 'Basant Panchami',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-01-23', '2027-02-11'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Basant Panchami, {{name}}!',
    message: 'Spring is officially here — and so is trekking season.',
    ctaPath: '/experiences?occasion=basant-panchami',
    suggestKeywords: ['spring', 'trek', 'garden', 'nature'],
  },
  {
    slug: 'maha-shivratri',
    name: 'Maha Shivratri',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-02-15', '2027-03-06'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Har Har Mahadev, {{name}}',
    message: 'Wishing you a blessed Maha Shivratri.',
    ctaPath: '/experiences?occasion=shivratri',
    suggestKeywords: ['temple', 'trek', 'heritage', 'rishikesh'],
  },
  {
    slug: 'holi',
    name: 'Holi',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-03-04', '2027-03-22', '2028-03-11'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Holi, {{name}}! 🌈',
    message: 'Colours, music and the last cool weekend before summer. Go somewhere for it.',
    offsetCopy: {
      '-1': {
        title: 'Holi is tomorrow, {{name}} 🌈',
        message: 'Holi getaways with slots still open — camps, farm stays and riverside stays.',
      },
    },
    ctaPath: '/experiences?occasion=holi',
    suggestKeywords: ['holi', 'camp', 'farm', 'riverside'],
  },
  {
    slug: 'ram-navami',
    name: 'Ram Navami',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-03-26', '2027-04-15'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Ram Navami, {{name}}!',
    message: 'Wishing you a blessed Ram Navami.',
    ctaPath: '/experiences?occasion=ram-navami',
    suggestKeywords: ['heritage', 'temple', 'ayodhya'],
  },
  {
    slug: 'mahavir-jayanti',
    name: 'Mahavir Jayanti',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-03-31', '2027-04-19'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Mahavir Jayanti, {{name}}',
    message: 'Wishing you peace and good health.',
    ctaPath: '/experiences',
    suggestKeywords: ['heritage', 'retreat', 'nature'],
  },
  {
    slug: 'buddha-purnima',
    name: 'Buddha Purnima',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-05-01', '2027-05-20'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Buddha Purnima, {{name}}',
    message: 'Monasteries, mountain silence and slow travel.',
    ctaPath: '/experiences?occasion=buddha-purnima',
    suggestKeywords: ['monastery', 'ladakh', 'retreat', 'meditation'],
  },
  {
    slug: 'onam',
    name: 'Onam',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-08-26', '2027-09-14'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Onam, {{name}}!',
    message: 'Wishing you a season of plenty — and a backwater break to go with it.',
    ctaPath: '/experiences?occasion=onam',
    suggestKeywords: ['kerala', 'backwater', 'houseboat', 'munnar'],
  },
  {
    slug: 'raksha-bandhan',
    name: 'Raksha Bandhan',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-08-28', '2027-08-17', '2028-08-05'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Raksha Bandhan, {{name}}!',
    message: 'Skip the chocolate box — gift a day out they will actually remember.',
    offsetCopy: {
      '-1': {
        title: 'Rakhi is tomorrow, {{name}}',
        message: 'Gift an experience instead — it can be booked tonight and used any weekend.',
      },
    },
    ctaPath: '/experiences?occasion=raksha-bandhan',
    suggestKeywords: ['gift', 'family', 'day out', 'adventure'],
  },
  {
    slug: 'janmashtami',
    name: 'Janmashtami',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-09-04', '2027-08-25'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Janmashtami, {{name}}!',
    message: 'Wishing you a joyful Janmashtami.',
    ctaPath: '/experiences?occasion=janmashtami',
    suggestKeywords: ['mathura', 'vrindavan', 'heritage'],
  },
  {
    slug: 'ganesh-chaturthi',
    name: 'Ganesh Chaturthi',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-09-14', '2027-09-04'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Ganpati Bappa Morya, {{name}}!',
    message: 'Wishing you a joyful Ganesh Chaturthi from all of us at reconnct.',
    ctaPath: '/experiences?occasion=ganesh-chaturthi',
    suggestKeywords: ['maharashtra', 'konkan', 'beach', 'trek'],
  },
  {
    slug: 'navratri',
    name: 'Navratri',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-10-11', '2027-09-30'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Navratri, {{name}}!',
    message: 'Nine nights of celebration — and the best travel weather of the year.',
    ctaPath: '/experiences?occasion=navratri',
    suggestKeywords: ['gujarat', 'garba', 'trek', 'weekend'],
  },
  {
    slug: 'dussehra',
    name: 'Dussehra',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-10-20', '2027-10-09'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Dussehra, {{name}}!',
    message: 'Good over evil, and a long weekend to celebrate it somewhere new.',
    ctaPath: '/experiences?occasion=dussehra',
    suggestKeywords: ['weekend', 'trek', 'camp', 'kullu'],
  },
  {
    slug: 'karva-chauth',
    name: 'Karwa Chauth',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-10-29', '2027-10-18'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Karwa Chauth, {{name}}!',
    message: 'Make the evening count — couple experiences and getaways near you.',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic', 'dinner', 'stay'],
  },
  {
    slug: 'diwali',
    name: 'Diwali',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-11-08', '2027-10-29', '2028-11-15'],
    needsDateCheck: true,
    sendOffsets: [-1, 0],
    channels: ALL,
    title: 'Happy Diwali, {{name}}! 🪔',
    message: 'Wishing you and your family light, laughter and a very good year ahead.',
    offsetCopy: {
      '-1': {
        title: 'Diwali is tomorrow, {{name}} 🪔',
        message: 'From all of us at reconnct — have a wonderful festival. And if you are planning a break after it, here is where to start.',
      },
    },
    ctaLabel: 'Plan a Diwali break',
    ctaPath: '/experiences?occasion=diwali',
    suggestKeywords: ['camp', 'resort', 'trek', 'getaway'],
  },
  {
    slug: 'bhai-dooj',
    name: 'Bhai Dooj',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-11-11', '2027-11-01'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Bhai Dooj, {{name}}!',
    message: 'A gift that is not another shirt — gift an experience instead.',
    ctaPath: '/experiences?occasion=bhai-dooj',
    suggestKeywords: ['gift', 'day out', 'adventure'],
  },
  {
    slug: 'chhath-puja',
    name: 'Chhath Puja',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-11-15', '2027-11-05'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Chhath Puja, {{name}}!',
    message: 'Wishing you and your family a blessed Chhath.',
    ctaPath: '/experiences',
    suggestKeywords: ['ghat', 'river', 'heritage'],
  },
  {
    slug: 'guru-nanak-jayanti',
    name: 'Guru Nanak Jayanti',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2026-11-24', '2027-11-13'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: LIGHT,
    title: 'Happy Gurpurab, {{name}}!',
    message: 'Wishing you peace and light on Guru Nanak Jayanti.',
    ctaPath: '/experiences?occasion=gurpurab',
    suggestKeywords: ['amritsar', 'punjab', 'heritage'],
  },
  {
    slug: 'eid-ul-fitr',
    name: 'Eid-ul-Fitr',
    type: 'festival',
    recurrence: 'dates',
    occurrences: ['2027-03-09', '2028-02-26'],
    needsDateCheck: true,
    sendOffsets: [0],
    channels: ALL,
    title: 'Eid Mubarak, {{name}}!',
    message: 'Wishing you and your family a joyful Eid.',
    ctaPath: '/experiences?occasion=eid',
    suggestKeywords: ['heritage', 'family', 'getaway'],
  },

  // ═══ 4. PERSONAL + WEEKLY ═══════════════════════════════════════════════
  {
    slug: 'weekend-getaway',
    name: 'Weekend',
    type: 'weekend',
    recurrence: 'weekly',
    weekday: 6, // Saturday
    sendOffsets: [-2], // Thursday evening — in time to actually plan
    sendHourIst: 18,
    sendMinuteIst: 0,
    // No email: a weekly mail to the whole base trains people to ignore us.
    channels: LIGHT,
    title: 'Weekend plan ready, {{name}}?',
    message: 'Short treks, camps and day-outs near you — bookable in a minute.',
    ctaLabel: 'See weekend plans',
    ctaPath: '/experiences?when=weekend',
    suggestKeywords: ['weekend', 'day trip', 'camp', 'trek'],
  },
  {
    slug: 'birthday',
    name: 'Birthday',
    type: 'birthday',
    recurrence: 'user_field',
    userField: 'dob',
    sendOffsets: [0],
    sendHourIst: 9,
    sendMinuteIst: 0,
    channels: ALL,
    title: 'Happy birthday, {{name}}! 🎉',
    message: 'Have a brilliant year ahead. Here is something to celebrate with.',
    ctaLabel: 'Pick your birthday plan',
    ctaPath: '/experiences?occasion=birthday',
    suggestKeywords: ['adventure', 'party', 'camp', 'day out'],
  },
  {
    slug: 'anniversary',
    name: 'Anniversary',
    type: 'anniversary',
    recurrence: 'user_field',
    userField: 'anniversary',
    sendOffsets: [0],
    sendHourIst: 9,
    sendMinuteIst: 0,
    channels: ALL,
    title: 'Happy anniversary, {{name}}! 💛',
    message: 'Celebrate it somewhere you will both remember — couple-friendly stays and experiences, handpicked.',
    ctaLabel: 'Plan the celebration',
    ctaPath: '/experiences?audience=couple',
    suggestKeywords: ['couple', 'romantic', 'resort', 'candle'],
  },
];

/*
  Email volume control.

  Every occasion above sends its push + in-app bell on every offset — those
  are free and unobtrusive. EMAIL is the scarce one: at two mails per festival
  the calendar would put ~50 marketing emails a year in one inbox, which is
  how a sending domain ends up in spam and how customers learn to ignore us.

  So by default the day-BEFORE wave drops email and goes out on push + bell
  only, and just the handful below — where a "last chance, book tonight"
  email genuinely converts — keep the day-before email too. A campaign that
  sets its own `channels` inside offsetCopy overrides all of this.
*/
const DAY_BEFORE_EMAIL = new Set([
  'diwali', 'holi', 'christmas', 'valentines-day', 'raksha-bandhan', 'mothers-day',
]);

const applyOffsetChannelPolicy = (campaign) => {
  const offsets = campaign.sendOffsets || [];
  if (!offsets.some((o) => o < 0)) return campaign;
  if (!(campaign.channels || ALL).includes('email')) return campaign;
  if (DAY_BEFORE_EMAIL.has(campaign.slug)) return campaign;

  const offsetCopy = { ...(campaign.offsetCopy || {}) };
  for (const offset of offsets.filter((o) => o < 0)) {
    const key = String(offset);
    const existing = offsetCopy[key] || {};
    // Never override an explicit per-offset channel choice.
    if (Array.isArray(existing.channels) && existing.channels.length) continue;
    offsetCopy[key] = { ...existing, channels: LIGHT };
  }
  return { ...campaign, offsetCopy };
};

const DEFAULTS = {
  type: 'festival',
  sendOffsets: [-1, 0],
  sendHourIst: 9,
  sendMinuteIst: 30,
  channels: ALL,
  ctaLabel: 'Explore experiences',
  ctaPath: '/experiences',
  imageUrl: null, // admin uploads the creative per campaign
  isActive: true,
  needsDateCheck: false,
};

/**
 * Idempotent. By default an existing slug is left completely alone — the seed
 * must never overwrite copy or dates an admin has since corrected. `force`
 * re-applies the shipped defaults (useful only right after editing this file).
 */
const seedCampaignCalendar = async ({ force = false, log = console.log } = {}) => {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of CAMPAIGNS) {
    const payload = applyOffsetChannelPolicy({ ...DEFAULTS, ...item });
    // eslint-disable-next-line no-await-in-loop
    const existing = await CampaignEvent.findOne({ where: { slug: item.slug } });
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await CampaignEvent.create(payload);
      created += 1;
    } else if (force) {
      // eslint-disable-next-line no-await-in-loop
      await existing.update(payload);
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  log(`[campaign-seed] ${created} created, ${updated} updated, ${skipped} left untouched`);
  return {
    created, updated, skipped, total: CAMPAIGNS.length,
  };
};

module.exports = { seedCampaignCalendar, CAMPAIGNS, applyOffsetChannelPolicy };

// CLI:  npm run seed:campaigns  [-- --force]
if (require.main === module) {
  (async () => {
    try {
      await sequelize.authenticate();
      await CampaignEvent.sync();
      const force = process.argv.includes('--force');
      await seedCampaignCalendar({ force });
      console.log('[campaign-seed] Lunar dates are marked "verify" — confirm them in Admin → Occasion Marketing.');
      process.exit(0);
    } catch (err) {
      console.error('[campaign-seed] failed:', err.message);
      process.exit(1);
    }
  })();
}

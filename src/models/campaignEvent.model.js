const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  A "wishing / occasion" campaign — the calendar the greeting engine runs off.

  There is no live holiday API in the loop. Indian festivals move every year
  (they follow the lunar calendar) but their dates are already published years
  ahead, and the *creative* — image, copy, which experiences to push — is a
  human decision an API can never supply. So the calendar lives here, seeded
  once and editable from Admin → Occasion Marketing.

  Four shapes of occasion, all resolved by campaignCalendar.service.js:

    recurrence          when it fires                         example
    ──────────────────────────────────────────────────────────────────────
    'dates'             each ISO date in `occurrences`        Diwali, Holi
    'yearly_fixed'      same month/day every year             26 Jan, 25 Dec
    'weekly'            every `weekday` (0=Sun … 6=Sat)       Weekend nudge
    'user_field'        each user's own dob / anniversary     Birthday wish

  `sendOffsets` is why "ek din pehle aur us din" needs no special-casing:
  [-1, 0] sends the day before AND on the day; [0] only on the day; [-2] is
  the Thursday nudge for a Saturday. Each (campaign, occurrence, offset,
  user, channel) is written to campaign_dispatches exactly once, so a restart
  or an extra sweep can never double-send.
*/
const CampaignEvent = sequelize.define(
  'CampaignEvent',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(80), allowNull: false },
    // festival | holiday | awareness | weekend | birthday | anniversary | sale
    type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'festival' },

    recurrence: {
      type: DataTypes.ENUM('dates', 'yearly_fixed', 'nth_weekday', 'weekly', 'user_field'),
      allowNull: false,
      defaultValue: 'dates',
    },
    // recurrence='dates' — ['2026-11-08','2027-10-29', …]
    occurrences: { type: DataTypes.JSON, allowNull: true },
    // recurrence='yearly_fixed' (also the month for 'nth_weekday')
    month: { type: DataTypes.INTEGER, allowNull: true },
    day: { type: DataTypes.INTEGER, allowNull: true },
    // recurrence='weekly' / 'nth_weekday' — JS getDay(): 0=Sunday … 6=Saturday
    weekday: { type: DataTypes.INTEGER, allowNull: true },
    /*
      recurrence='nth_weekday' — "2nd Sunday of May". Mother's Day, Father's
      Day and Friendship Day have no fixed date but a completely fixed RULE,
      so they are computed forever instead of being re-entered every year.
      1-4 = that week; -1 = the last one in the month.
    */
    nthWeek: { type: DataTypes.INTEGER, allowNull: true },
    // recurrence='user_field' — which User column holds the personal date
    userField: { type: DataTypes.STRING(20), allowNull: true }, // 'dob' | 'anniversary'

    // Lunar dates were seeded from a published calendar, not an API. This flag
    // makes the admin page nag until a human has confirmed them.
    needsDateCheck: { type: DataTypes.BOOLEAN, defaultValue: false },

    // Days relative to the occasion. [-1, 0] = day before + on the day.
    sendOffsets: { type: DataTypes.JSON, allowNull: false, defaultValue: [-1, 0] },
    // Local (IST) send time. The sweep holds the wave until this has passed.
    sendHourIst: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 9 },
    sendMinuteIst: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },

    // Any of: 'email' | 'push' | 'inapp'. All three are free — no WhatsApp.
    channels: { type: DataTypes.JSON, allowNull: false, defaultValue: ['email', 'push', 'inapp'] },

    // Copy. {{name}} / {{occasion}} are substituted per recipient.
    title: { type: DataTypes.STRING(200), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: true },
    // Optional per-offset override: { "-1": { title, message }, "0": { … } }.
    // Falls back to title/message when an offset isn't listed.
    offsetCopy: { type: DataTypes.JSON, allowNull: true },

    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    ctaLabel: { type: DataTypes.STRING(80), allowNull: true, defaultValue: 'Explore experiences' },
    // Relative path on the site/app, e.g. '/experiences?occasion=diwali'
    ctaPath: { type: DataTypes.STRING(300), allowNull: true },
    couponCode: { type: DataTypes.STRING(40), allowNull: true },

    // Targeting. Empty / null everywhere = every opted-in user.
    targetCities: { type: DataTypes.JSON, allowNull: true },
    targetCategoryIds: { type: DataTypes.JSON, allowNull: true },
    // Experiences to render as cards inside the email (max 3 used).
    promoteExperienceIds: { type: DataTypes.JSON, allowNull: true },

    /*
      What to SUGGEST alongside the wish — the half that turns a greeting into
      a booking. Yoga Day should surface wellness retreats, Bicycle Day should
      surface cycling, Children's Day should surface family outings.

      suggestKeywords matches an experience's name / about / location, so it
      works on day one without anyone tagging the catalogue first.
      targetAudienceIds matches the taxonomy properly (couple / family /
      friends) when the catalogue IS tagged. Both are optional; with neither,
      the email falls back to recent published experiences near the reader.
    */
    suggestKeywords: { type: DataTypes.JSON, allowNull: true },
    targetAudienceIds: { type: DataTypes.JSON, allowNull: true },

    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    lastRunAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'campaign_events',
    indexes: [
      { name: 'campaign_events_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
      { fields: ['recurrence'] },
    ],
  }
);

module.exports = CampaignEvent;

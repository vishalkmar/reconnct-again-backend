const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  One row per (campaign, occurrence, offset, user, channel) that the greeting
  engine has already handled. Two jobs:

  1. Idempotency. The unique index below is what makes a 15-minute sweep safe:
     the row is INSERTed *before* the send, so a restart, an overlapping run
     or a manual "run now" can never wish the same person twice. This is the
     multi-user version of the reminderEmailSentAt flag in reminder.service.js.

  2. The in-app feed. 'inapp' rows carry a snapshot of the copy/image/CTA, so
     notification.controller.js can render the greeting in the bell without
     re-resolving the campaign (and without breaking if the admin later edits
     the campaign's wording).
*/
const CampaignDispatch = sequelize.define(
  'CampaignDispatch',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    campaignEventId: { type: DataTypes.INTEGER, allowNull: false },
    // The occasion's own date (NOT the send date) — the day-before mail and
    // the day-of mail share this, and differ by offsetDay.
    occurrenceDate: { type: DataTypes.DATEONLY, allowNull: false },
    offsetDay: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    userId: { type: DataTypes.INTEGER, allowNull: false },
    channel: { type: DataTypes.STRING(12), allowNull: false }, // email | push | inapp
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'sent' }, // sent | failed
    error: { type: DataTypes.TEXT, allowNull: true },

    // Snapshot (used by the in-app feed).
    title: { type: DataTypes.STRING(200), allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: true },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    ctaPath: { type: DataTypes.STRING(300), allowNull: true },

    /*
      Set when two occasions fell on the same send moment and were delivered
      as ONE message (11 Feb 2027 = Promise Day + Basant Panchami). The lead
      occasion's row is the real greeting; the tag-along rows carry this and
      exist only so a later sweep knows those occasions are already covered.
      The in-app feed hides them, or the bell would show the same wish twice.
    */
    mergedIntoCampaignId: { type: DataTypes.INTEGER, allowNull: true },

    readAt: { type: DataTypes.DATE, allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },

    /*
      ── Engagement, so "did this wave do anything?" has an answer ──────────

      Handing a mail to the SMTP server is not the same as anybody reading it.
      These four columns are the funnel — sent → opened → clicked → explored —
      recorded per recipient rather than as a bare campaign counter, so the
      admin can ask which occasion, which beat and which channel actually
      moved people.

      openedAt is EMAIL ONLY and is the softest number here: it comes from a
      tracking pixel, which Gmail proxies and Apple Mail Privacy Protection
      pre-fetches, so it over-counts. Clicks are the honest metric and the
      dashboard says so rather than quietly presenting both as equals.

      clickKind separates the two things a click can mean: 'experience' is
      someone who tapped a suggested experience — the one that matters —
      while 'browse' is the generic CTA. clickVia records whether they chose
      the app or the browser at the chooser.
    */
    openedAt: { type: DataTypes.DATE, allowNull: true },
    clickedAt: { type: DataTypes.DATE, allowNull: true },
    clickCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    clickKind: { type: DataTypes.STRING(12), allowNull: true }, // experience | browse
    clickVia: { type: DataTypes.STRING(10), allowNull: true }, // app | browser
  },
  {
    tableName: 'campaign_dispatches',
    indexes: [
      {
        name: 'campaign_dispatch_once',
        unique: true,
        fields: ['campaignEventId', 'occurrenceDate', 'offsetDay', 'userId', 'channel'],
      },
      { fields: ['userId', 'channel'] },
      { fields: ['occurrenceDate'] },
      // The analytics dashboard filters on these constantly.
      { fields: ['clickedAt'] },
    ],
  }
);

module.exports = CampaignDispatch;

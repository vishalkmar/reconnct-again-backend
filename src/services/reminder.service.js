const { Op } = require('sequelize');
const { Booking, Experience, User } = require('../models');
const { sendGuestReminder, sendHostReminder, sendExperienceCompleted } = require('./bookingEmail.service');
const { sendPushToUser } = require('./push.service');

/*
  Booking reminder sweep — a single "starting in 6 hours" EMAIL to both the
  guest and the listing's host. The equivalent in-app "starting in 1 hour"
  notification is handled separately: notification.controller.js's derived
  feed shows it live whenever a client asks, no active dispatch needed for
  that one. Runs on a periodic timer (see server.js) rather than a precise
  per-booking schedule; reminderEmailSentAt makes the wave idempotent no
  matter how often the sweep runs.
*/

const HOUR_MS = 60 * 60 * 1000;
const EMAIL_HOURS_BEFORE = 6;

const runWave = async ({ hoursBefore, field }) => {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + hoursBefore * HOUR_MS);
  const due = await Booking.findAll({
    where: {
      status: 'confirmed',
      scheduledAt: { [Op.gt]: now, [Op.lte]: windowEnd },
      [field]: null,
    },
  });

  for (const booking of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendGuestReminder({ booking, hoursBefore });
    } catch (err) {
      console.error('[reminder] guest email failed:', err.message);
    }

    sendPushToUser(booking.userId, {
      title: 'Upcoming experience',
      body: `${booking.itemSnapshot?.name || 'Your experience'} starts in about ${hoursBefore} hour${hoursBefore === 1 ? '' : 's'}.`,
      data: { kind: 'reminder', bookingCode: booking.bookingCode, isHostBooking: 'false' },
    }).catch(() => {});

    if (booking.itemType === 'experience') {
      try {
        // eslint-disable-next-line no-await-in-loop
        const exp = await Experience.findByPk(booking.itemId);
        if (exp && exp.ownerUserId) {
          // eslint-disable-next-line no-await-in-loop
          const host = await User.findByPk(exp.ownerUserId);
          if (host) {
            // eslint-disable-next-line no-await-in-loop
            await sendHostReminder({ booking, exp, host, hoursBefore });
            sendPushToUser(host.id, {
              title: 'Upcoming booking',
              body: `${exp.name || 'Your listing'} has a guest arriving in about ${hoursBefore} hour${hoursBefore === 1 ? '' : 's'}.`,
              data: { kind: 'reminder', bookingId: booking.id, isHostBooking: 'true' },
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('[reminder] host email failed:', err.message);
      }
    }

    booking[field] = new Date();
    // eslint-disable-next-line no-await-in-loop
    await booking.save();
  }

  return due.length;
};

const sweepReminders = async () => {
  try {
    const n = await runWave({ hoursBefore: EMAIL_HOURS_BEFORE, field: 'reminderEmailSentAt' });
    if (n) console.log(`[reminder] sent ${n} ${EMAIL_HOURS_BEFORE}h-before email reminder(s)`);
  } catch (err) {
    console.error('[reminder] sweep failed:', err.message);
  }
};

/*
  Post-experience wave — the "hope you enjoyed it, please rate us" email AND a
  system push.

  The app already prompts for a review in-app (bookings/me/pending-review),
  but that only ever fires for someone who happens to reopen the app. This is
  the outward nudge: it lands on the lock screen, and tapping it deep-links
  straight to the rating (kind:'review' → routeForPush in the app).

  "Completed" matches the rule the review prompt itself uses — a confirmed
  booking whose scheduled instant has passed — plus a grace period so the mail
  doesn't arrive while the guest is still there. Idempotent via
  completionEmailSentAt.
*/
const COMPLETION_GRACE_HOURS = 3;
/*
  Unlike the reminder wave (which only ever looks FORWARD), this one looks
  backward — so without a floor the very first run after deploy would mail
  every historical booking in the database at once. Anything that finished
  more than a few days ago is water under the bridge; asking for a review then
  is worse than not asking.
*/
const COMPLETION_MAX_AGE_DAYS = 7;

const runCompletionWave = async () => {
  const now = Date.now();
  const cutoff = new Date(now - COMPLETION_GRACE_HOURS * HOUR_MS);
  const floor = new Date(now - COMPLETION_MAX_AGE_DAYS * 24 * HOUR_MS);
  const due = await Booking.findAll({
    where: {
      itemType: 'experience',
      status: { [Op.in]: ['confirmed', 'completed'] },
      scheduledAt: { [Op.ne]: null, [Op.lte]: cutoff, [Op.gte]: floor },
      completionEmailSentAt: null,
    },
    limit: 200,
  });

  for (const booking of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendExperienceCompleted({ booking });
    } catch (err) {
      console.error('[completion] guest email failed:', err.message);
    }

    const name = booking.itemSnapshot?.name || 'your experience';
    sendPushToUser(booking.userId, {
      title: `How was ${name}? 🎉`,
      body: 'Thanks for coming along! Tap to rate your experience — it takes a few seconds.',
      data: { kind: 'review', bookingCode: booking.bookingCode, isHostBooking: 'false' },
    }).catch(() => {});

    booking.completionEmailSentAt = new Date();
    // eslint-disable-next-line no-await-in-loop
    await booking.save();
  }

  return due.length;
};

const sweepCompletions = async () => {
  try {
    const n = await runCompletionWave();
    if (n) console.log(`[completion] sent ${n} post-experience review request(s)`);
  } catch (err) {
    console.error('[completion] sweep failed:', err.message);
  }
};

module.exports = { sweepReminders, sweepCompletions };

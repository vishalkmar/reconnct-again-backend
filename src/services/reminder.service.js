const { Op } = require('sequelize');
const { Booking, Experience, User } = require('../models');
const { sendGuestReminder, sendHostReminder } = require('./bookingEmail.service');

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

    if (booking.itemType === 'experience') {
      try {
        // eslint-disable-next-line no-await-in-loop
        const exp = await Experience.findByPk(booking.itemId);
        if (exp && exp.ownerUserId) {
          // eslint-disable-next-line no-await-in-loop
          const host = await User.findByPk(exp.ownerUserId);
          // eslint-disable-next-line no-await-in-loop
          if (host) await sendHostReminder({ booking, exp, host, hoursBefore });
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

module.exports = { sweepReminders };

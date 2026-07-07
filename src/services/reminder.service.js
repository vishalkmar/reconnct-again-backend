const { Op } = require('sequelize');
const { Booking, Experience, User } = require('../models');
const { sendGuestReminder, sendHostReminder } = require('./bookingEmail.service');

/*
  Booking reminder sweep — fires a "starting in N hours" email (+ the
  in-app notifications feed picks up the same window separately) to both
  the guest and the listing's host, once at 12 hours before and once at
  2 hours before. Runs on a periodic timer (see server.js) rather than a
  precise per-booking schedule; the reminderXhSentAt columns make each wave
  idempotent no matter how often the sweep runs.
*/

const HOUR_MS = 60 * 60 * 1000;

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
    const n12 = await runWave({ hoursBefore: 12, field: 'reminder12hSentAt' });
    const n2 = await runWave({ hoursBefore: 2, field: 'reminder2hSentAt' });
    if (n12 || n2) console.log(`[reminder] sent ${n12} 12h + ${n2} 2h reminder wave(s)`);
  } catch (err) {
    console.error('[reminder] sweep failed:', err.message);
  }
};

module.exports = { sweepReminders };

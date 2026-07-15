const { getApp, isConfigured } = require('../config/firebaseAdmin');
const { User } = require('../models');

// Every push carries BOTH a `notification` block (so Android auto-displays
// it from the system tray even while the app is backgrounded or fully
// killed — no JS needs to run) and a `data` block (the app reads this to
// route the tap to the right screen; see App/reconnct's routeForPush()).
// FCM requires every data value to be a string.
const stringifyData = (data = {}) => {
  const out = {};
  Object.entries(data).forEach(([k, v]) => {
    if (v !== undefined && v !== null) out[k] = String(v);
  });
  return out;
};

// Sends to a single user's registered device. Silently does nothing if push
// isn't configured (no FIREBASE_SERVICE_ACCOUNT) or the user has no token —
// callers never need to guard around either case. Clears a token that FCM
// reports as dead so it doesn't keep failing forever.
const sendPushToUser = async (userId, { title, body, data } = {}) => {
  if (!isConfigured() || !userId) return;
  try {
    const user = await User.findByPk(userId);
    if (!user || !user.fcmToken) return;

    const app = getApp();
    if (!app) return;

    await app.messaging().send({
      token: user.fcmToken,
      notification: { title, body },
      data: stringifyData(data),
      android: {
        priority: 'high',
        notification: { channelId: 'reconnct-default', color: '#FFB900' },
      },
    });
  } catch (err) {
    const code = err && err.errorInfo && err.errorInfo.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      try { await User.update({ fcmToken: null }, { where: { id: userId } }); } catch { /* ignore */ }
    } else {
      console.warn('[push] send failed:', err.message);
    }
  }
};

module.exports = { sendPushToUser };

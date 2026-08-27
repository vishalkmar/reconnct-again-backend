const { getMessaging } = require('firebase-admin/messaging');
const { getApp, isConfigured } = require('../config/firebaseAdmin');
const { User, Supplier } = require('../models');

/*
  Server → device push.

  Every push carries BOTH a `notification` block (so Android auto-displays it
  from the system tray even while the app is backgrounded or fully killed — no
  JS needs to run) and a `data` block (the app reads this to route the tap; see
  App/reconnct's routeForPush()). FCM requires every data value to be a string.

  ── Why the android block is this specific ────────────────────────────────
  A notification that arrives silently is, to the person holding the phone,
  a notification that did not arrive. Android 8+ takes sound, vibration and
  heads-up behaviour from the CHANNEL, not from the message — so the channel
  id below has to name a channel the app actually created with HIGH
  importance, and it has to be the same string the app's manifest names as
  `default_notification_channel_id`. Push to a channel the app never created
  and the OS drops the notification outright.

  CHANNEL_ID is therefore the single source of truth shared with
  App/reconnct/src/services/pushNotifications.js — change it in both, or in
  neither. It is versioned (…-v2) because Android channel settings are
  IMMUTABLE once created: a device that already has the old silent
  'reconnct-default' channel would keep it silent forever, however the app
  re-creates it. A new id is the only way to hand an existing install a
  channel that actually rings.
*/
const CHANNEL_ID = 'reconnct-alerts-v2';

const stringifyData = (data = {}) => {
  const out = {};
  Object.entries(data).forEach(([k, v]) => {
    if (v !== undefined && v !== null) out[k] = String(v);
  });
  return out;
};

// The android half of every message. `sound: 'default'` and
// defaultVibrateTimings are belt-and-braces on top of the channel: on the
// devices that honour per-message settings they matter, and where the channel
// wins they are simply ignored.
const androidConfig = () => ({
  // Message priority — wakes a dozing device instead of queuing until the
  // next maintenance window. Without it a push can land hours late.
  priority: 'high',
  notification: {
    channelId: CHANNEL_ID,
    color: '#FFB900',
    sound: 'default',
    defaultVibrateTimings: true,
    // Notification priority — pre-Oreo devices, and the heads-up hint.
    priority: 'high',
    visibility: 'public',
  },
});

const apnsConfig = () => ({
  payload: { aps: { sound: 'default', badge: 1 } },
  headers: { 'apns-priority': '10' },
});

/**
 * Sends to a single user's registered device.
 *
 * Returns a RESULT rather than throwing or silently doing nothing:
 * `{ ok: true }` or `{ ok: false, reason }`. Callers in the send path ignore
 * it (a missing device is not a booking failure), but the admin test button
 * shows the reason verbatim — "push didn't arrive" is otherwise impossible to
 * tell apart from "no token", "not configured" and "FCM rejected it".
 */
const sendPushToUser = async (userId, { title, body, data } = {}) => {
  if (!userId) return { ok: false, reason: 'no user id' };
  if (!isConfigured()) {
    console.warn('[push] skipped (user %s): FCM not configured', userId);
    return { ok: false, reason: 'FCM not configured on this server (FIREBASE_SERVICE_ACCOUNT is unset)' };
  }
  try {
    const user = await User.findByPk(userId);
    if (!user) { console.warn('[push] skipped: no user %s', userId); return { ok: false, reason: 'user not found' }; }
    if (!user.fcmToken) {
      console.warn('[push] skipped (user %s): no device token registered', userId);
      return { ok: false, reason: 'no device token — open the app and sign in on the phone first' };
    }

    const app = getApp();
    if (!app) return { ok: false, reason: 'FCM credentials are invalid' };

    const id = await getMessaging(app).send({
      token: user.fcmToken,
      notification: { title, body },
      data: stringifyData(data),
      android: androidConfig(),
      apns: apnsConfig(),
    });
    return { ok: true, messageId: id };
  } catch (err) {
    const code = err && err.errorInfo && err.errorInfo.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      try { await User.update({ fcmToken: null }, { where: { id: userId } }); } catch { /* ignore */ }
      return { ok: false, reason: 'the device token is dead (app reinstalled?) — cleared it, sign in again on the phone' };
    }
    console.warn('[push] send failed:', err.message);
    return { ok: false, reason: err.message };
  }
};

// Same as sendPushToUser, but for a Supplier's device (their own app login).
// Suppliers are a separate model with their own fcmToken, so a booking on a
// supplier-owned listing can reach them on the lock screen too.
const sendPushToSupplier = async (supplierId, { title, body, data } = {}) => {
  if (!isConfigured() || !supplierId) return { ok: false, reason: 'FCM not configured' };
  try {
    const supplier = await Supplier.findByPk(supplierId);
    if (!supplier || !supplier.fcmToken) return { ok: false, reason: 'no device token' };

    const app = getApp();
    if (!app) return { ok: false, reason: 'FCM credentials are invalid' };

    const id = await getMessaging(app).send({
      token: supplier.fcmToken,
      notification: { title, body },
      data: stringifyData(data),
      android: androidConfig(),
      apns: apnsConfig(),
    });
    return { ok: true, messageId: id };
  } catch (err) {
    const code = err && err.errorInfo && err.errorInfo.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      try { await Supplier.update({ fcmToken: null }, { where: { id: supplierId } }); } catch { /* ignore */ }
      return { ok: false, reason: 'device token is dead — cleared it' };
    }
    console.warn('[push] supplier send failed:', err.message);
    return { ok: false, reason: err.message };
  }
};

module.exports = { sendPushToUser, sendPushToSupplier, CHANNEL_ID };

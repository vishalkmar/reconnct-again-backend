const { Notification } = require('../models');
const { emitToUser } = require('./socket');

// Persists a notification row and pushes it down the recipient's user
// socket room. This is the only delivery channel — the PWA bell + toast
// pick the event up in real-time. Failure to create the row is logged but
// never thrown, so the originating business action isn't blocked.
const notifyUser = async ({
  role, userId, type, title, body, propertyId, data,
}) => {
  if (!role || !userId || !type || !title) return null;
  try {
    const notification = await Notification.create({
      recipientType: role,
      recipientId: userId,
      type,
      title,
      body: body || null,
      propertyId: propertyId || null,
      data: data || {},
    });
    emitToUser(role, userId, 'notification:new', { notification });
    return notification;
  } catch (err) {
    console.error('[notifications] failed to create', err.message);
    return null;
  }
};

module.exports = { notifyUser };

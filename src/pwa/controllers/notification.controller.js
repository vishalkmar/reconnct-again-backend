const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { Notification } = require('../models');
const { ok, fail } = require('../../utils/response');

// Notifications are scoped to the authenticated PWA user. The route file
// mounts the same controller for every role; the auth middleware sets
// req.pwaUser + req.pwaRole, and we filter by both.

const buildScope = (req) => ({
  recipientType: req.pwaRole,
  recipientId: req.pwaUser.id,
});

const list = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const items = await Notification.findAll({
    where: buildScope(req),
    order: [['createdAt', 'DESC']],
    limit,
  });
  const unread = await Notification.count({
    where: { ...buildScope(req), readAt: null },
  });
  return ok(res, { items, unread });
});

const unreadCount = asyncHandler(async (req, res) => {
  const unread = await Notification.count({
    where: { ...buildScope(req), readAt: null },
  });
  return ok(res, { unread });
});

const markRead = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return fail(res, 'Invalid id', 400);
  const row = await Notification.findOne({
    where: { id, ...buildScope(req) },
  });
  if (!row) return fail(res, 'Notification not found', 404);
  if (!row.readAt) {
    row.readAt = new Date();
    await row.save();
  }
  return ok(res, { notification: row });
});

const markAllRead = asyncHandler(async (req, res) => {
  await Notification.update(
    { readAt: new Date() },
    {
      where: {
        ...buildScope(req),
        readAt: { [Op.is]: null },
      },
    },
  );
  return ok(res, {}, 'All marked as read');
});

module.exports = { list, unreadCount, markRead, markAllRead };

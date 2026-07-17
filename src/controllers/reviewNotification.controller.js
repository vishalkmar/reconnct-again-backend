const asyncHandler = require('express-async-handler');
const { ReviewNotification } = require('../models');
const { ok, fail } = require('../utils/response');

// GET /api/team/review-notifications — this team member's review pings,
// newest first, with an unread count for the bell badge.
const list = asyncHandler(async (req, res) => {
  const where = { recipientType: 'team', recipientId: req.teamMember.id };
  const [items, unread] = await Promise.all([
    ReviewNotification.findAll({ where, order: [['createdAt', 'DESC']], limit: 50 }),
    ReviewNotification.count({ where: { ...where, readAt: null } }),
  ]);
  return ok(res, { items, unread });
});

// POST /api/team/review-notifications/read-all
const readAll = asyncHandler(async (req, res) => {
  await ReviewNotification.update(
    { readAt: new Date() },
    { where: { recipientType: 'team', recipientId: req.teamMember.id, readAt: null } },
  );
  return ok(res, {}, 'Marked all as read');
});

// POST /api/team/review-notifications/:id/read
const readOne = asyncHandler(async (req, res) => {
  const row = await ReviewNotification.findOne({
    where: { id: req.params.id, recipientType: 'team', recipientId: req.teamMember.id },
  });
  if (!row) return fail(res, 'Notification not found', 404);
  if (!row.readAt) { row.readAt = new Date(); await row.save(); }
  return ok(res, { item: row });
});

module.exports = { list, readAll, readOne };

const asyncHandler = require('express-async-handler');
const { User, Booking } = require('../models');
const { ok } = require('../utils/response');

// GET /api/team/my-customers — the signed-in CSM's assigned customers
// (round-robin assigned the moment they hit a failed-payment or
// cancellation signal — see csm.service.js), each with a quick booking
// health summary so the CSM can tell who needs a follow-up right now.
const myCustomers = asyncHandler(async (req, res) => {
  const users = await User.findAll({
    where: { csmId: req.teamMember.id },
    attributes: ['id', 'name', 'email', 'phone', 'avatarUrl', 'createdAt'],
    order: [['name', 'ASC']],
  });

  const ids = users.map((u) => u.id);
  const bookings = ids.length
    ? await Booking.findAll({
        where: { userId: ids },
        attributes: ['id', 'userId', 'status', 'paymentFailedAt'],
      })
    : [];

  const items = users.map((u) => {
    const own = bookings.filter((b) => b.userId === u.id);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt,
      stats: {
        total: own.length,
        failedPayments: own.filter((b) => b.paymentFailedAt).length,
        cancelled: own.filter((b) => b.status === 'cancelled').length,
      },
    };
  });

  return ok(res, { items });
});

module.exports = { myCustomers };

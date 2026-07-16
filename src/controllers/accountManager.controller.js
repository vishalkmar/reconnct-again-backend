const asyncHandler = require('express-async-handler');
const { Supplier, Experience } = require('../models');
const { ok } = require('../utils/response');

// GET /api/team/my-suppliers — the signed-in Account Manager's assigned
// suppliers (round-robin assigned — see accountManager.service.js), each
// with a quick experience-status summary so the AM can tell who needs
// guidance right now without opening every supplier individually.
const mySuppliers = asyncHandler(async (req, res) => {
  const suppliers = await Supplier.findAll({
    where: { accountManagerId: req.teamMember.id },
    order: [['companyName', 'ASC']],
  });

  const ids = suppliers.map((s) => s.id);
  const experiences = ids.length
    ? await Experience.findAll({ where: { supplierId: ids }, attributes: ['id', 'supplierId', 'status'] })
    : [];

  const items = suppliers.map((s) => {
    const own = experiences.filter((e) => e.supplierId === s.id);
    return {
      ...s.toSafeJSON(),
      stats: {
        total: own.length,
        pendingReview: own.filter((e) => e.status === 'pending_review').length,
        published: own.filter((e) => e.status === 'published').length,
        archived: own.filter((e) => e.status === 'archived').length,
      },
    };
  });

  return ok(res, { items });
});

module.exports = { mySuppliers };

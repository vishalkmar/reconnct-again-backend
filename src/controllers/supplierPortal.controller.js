const asyncHandler = require('express-async-handler');
const { Supplier, TeamMember, Experience } = require('../models');
const { ROLE_LABELS } = require('../models/teamMember.model');
const { ok } = require('../utils/response');

/*
  Supplier-portal endpoints that have no Host equivalent (everything else on
  /api/supplier/* is a straight clone of the Host controller — see
  routes/supplierPortal.routes.js).
*/

// GET /api/supplier/account-manager — who from the reconnct team looks after
// this supplier. Assigned by round-robin the first time any experience gets
// linked to them (services/accountManager.service), so a brand-new supplier
// with no listings yet legitimately has none — the UI says so rather than
// erroring. Read-only: never assigns as a side effect of a GET.
const accountManager = asyncHandler(async (req, res) => {
  const supplier = await Supplier.findByPk(req.supplier.id, {
    attributes: ['id', 'companyName', 'accountManagerId'],
  });

  if (!supplier || !supplier.accountManagerId) {
    return ok(res, { manager: null, since: null });
  }

  const m = await TeamMember.findByPk(supplier.accountManagerId, {
    attributes: ['id', 'name', 'email', 'employeeCode', 'roleType', 'isActive', 'createdAt'],
  });
  if (!m) return ok(res, { manager: null, since: null });

  // How long they've been looking after this supplier is best approximated by
  // the supplier's first listing — assignment happens at that moment and isn't
  // separately timestamped.
  const first = await Experience.findOne({
    where: { supplierId: supplier.id },
    attributes: ['createdAt'],
    order: [['createdAt', 'ASC']],
  });

  return ok(res, {
    manager: {
      id: m.id,
      name: m.name,
      email: m.email,
      employeeCode: m.employeeCode,
      roleType: m.roleType,
      roleLabel: ROLE_LABELS[m.roleType] || m.roleType,
      isActive: m.isActive,
    },
    since: first ? first.createdAt : null,
  });
});

module.exports = { accountManager };

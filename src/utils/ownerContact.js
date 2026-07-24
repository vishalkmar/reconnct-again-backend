const { Supplier, User } = require('../models');

/*
  Who owns this experience, in ONE shape, whoever they are.

  QCOPS needs the same thing for every visit — a company/person, a phone, an
  email and the site address — but that lived only on the Supplier row. A
  host-submitted listing has no supplier record (it hangs off ownerUserId), so
  every QCOPS surface showed blanks for hosts. This returns the supplier-shaped
  object for both, so callers (and the QCOPS UI) need no branching.
*/
const ownerContactFor = async (exp) => {
  if (!exp) return null;
  if (exp.supplierId) {
    const s = await Supplier.findByPk(exp.supplierId, {
      attributes: ['id', 'companyName', 'supplierName', 'email', 'phone'],
    });
    if (!s) return null;
    return {
      kind: 'supplier',
      id: s.id,
      companyName: s.companyName,
      supplierName: s.supplierName,
      email: s.email,
      phone: s.phone,
    };
  }
  if (exp.ownerUserId) {
    const u = await User.findByPk(exp.ownerUserId, {
      attributes: ['id', 'name', 'email', 'phone', 'company', 'city'],
    });
    if (!u) return null;
    return {
      kind: 'host',
      id: u.id,
      // A host IS the business here, so their name doubles as the company —
      // keeps the existing "Company / Contact person" layout meaningful.
      companyName: u.company || u.name || 'Host',
      supplierName: u.name,
      email: u.email,
      phone: u.phone,
    };
  }
  return null;
};

const siteAddressOf = (exp) => [exp && exp.location, exp && exp.nearbyLocation, exp && exp.city]
  .filter(Boolean).join(', ');

module.exports = { ownerContactFor, siteAddressOf };

// One-off (run manually): every Experience whose admin-assigned Supplier is
// "Test Supplier" gets ownerUserId pointed at yamunainfra3@gmail.com (real
// name + phone filled in too), so the user can book one of these and watch
// the FULL host flow — confirmation email, host notification email, host
// in-app notification, My Listings booking card — all land on one real
// account instead of being split round-robin across the 5 test emails.
//
// Run with: node src/scripts/attachYamunaHost.js

const { sequelize } = require('../config/database');
const { User, Experience, Supplier } = require('../models');

const HOST_EMAIL = 'yamunainfra3@gmail.com';
const HOST_NAME = 'Yamuna infra';
const HOST_PHONE = '9540792427';

const run = async () => {
  await sequelize.authenticate();
  console.log('[attachYamunaHost] connected to DB');

  const [host] = await User.findOrCreate({
    where: { email: HOST_EMAIL },
    defaults: { email: HOST_EMAIL, isProfileComplete: true },
  });
  host.name = HOST_NAME;
  host.phone = HOST_PHONE;
  await host.save();
  console.log(`[attachYamunaHost] host profile set: ${HOST_EMAIL} (id ${host.id}) name="${HOST_NAME}" phone=${HOST_PHONE}`);

  const testSuppliers = await Supplier.findAll();
  const targetSupplierIds = testSuppliers
    .filter((s) => /test supplier/i.test(s.supplierName || '') || /test supplier/i.test(s.companyName || ''))
    .map((s) => s.id);
  if (!targetSupplierIds.length) {
    console.log('[attachYamunaHost] no "Test Supplier" rows found — nothing to do.');
    process.exit(0);
  }

  const exps = await Experience.findAll({ where: { supplierId: targetSupplierIds } });
  console.log(`[attachYamunaHost] ${exps.length} experience(s) under Test Supplier`);
  for (const exp of exps) {
    exp.ownerUserId = host.id;
    // eslint-disable-next-line no-await-in-loop
    await exp.save();
    console.log(`  -> "${exp.name}" (#${exp.id}) -> ${HOST_EMAIL}`);
  }

  console.log('[attachYamunaHost] done.');
  process.exit(0);
};

run().catch((err) => {
  console.error('[attachYamunaHost] failed:', err);
  process.exit(1);
});

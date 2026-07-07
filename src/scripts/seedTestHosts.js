// One-off (run manually, NOT wired into server.js startup): ensures the 5
// given test emails have User accounts, then assigns them as the host
// (ownerUserId) for every CURRENTLY-HOSTLESS Experience — round-robin — so
// the "your listing got booked" email/notification/My-Listings flow can be
// tested end-to-end against real data instead of admin-authored experiences
// that have nobody to notify.
//
// Safe to re-run: User lookup is findOrCreate, and only Experience rows with
// ownerUserId IS NULL are touched — already-assigned hosts are left alone.
//
// Run with: node src/scripts/seedTestHosts.js

const { sequelize } = require('../config/database');
const { User, Experience } = require('../models');

const TEST_HOST_EMAILS = [
  'vk7224132@gmail.com',
  'vashisthimanshu60@gmail.com',
  'nexatechinnovation4@gmail.com',
  'suhailx187@gmail.com',
  'yamunainfra3@gmail.com',
];

const run = async () => {
  await sequelize.authenticate();
  console.log('[seedTestHosts] connected to DB');

  const hosts = [];
  for (const email of TEST_HOST_EMAILS) {
    const [user, wasCreated] = await User.findOrCreate({
      where: { email },
      defaults: { email, isProfileComplete: true, name: email.split('@')[0] },
    });
    hosts.push(user);
    console.log(`[seedTestHosts] host ${wasCreated ? 'created' : 'already existed'}: ${email} (id ${user.id})`);
  }

  const orphans = await Experience.findAll({ where: { ownerUserId: null } });
  console.log(`[seedTestHosts] ${orphans.length} hostless experience(s) found`);

  let i = 0;
  for (const exp of orphans) {
    const host = hosts[i % hosts.length];
    exp.ownerUserId = host.id;
    // eslint-disable-next-line no-await-in-loop
    await exp.save();
    console.log(`  -> "${exp.name}" (#${exp.id}) -> ${host.email}`);
    i += 1;
  }

  console.log('[seedTestHosts] done.');
  process.exit(0);
};

run().catch((err) => {
  console.error('[seedTestHosts] failed:', err);
  process.exit(1);
});

require('dotenv').config();
const { sequelize, Admin } = require('../models');

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log('[SEED] Connected to DB');

    const email = (process.env.ADMIN_EMAIL || 'admin@traveon.com').toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || 'Admin@12345';
    const name = process.env.ADMIN_NAME || 'Super Admin';

    const existing = await Admin.findOne({ where: { email } });
    if (existing) {
      console.log(`[SEED] Admin already exists: ${email}`);
      process.exit(0);
    }

    const admin = await Admin.create({ email, password, name, role: 'superadmin' });
    console.log(`[SEED] Admin created: ${admin.email}`);
    process.exit(0);
  } catch (err) {
    console.error('[SEED] Failed:', err.message);
    process.exit(1);
  }
};

run();

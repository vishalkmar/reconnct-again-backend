/*
  One-off cleanup: wipe all bookings, wallet transactions and wishlist entries so
  the app + website start from a clean, matching slate. Wallet balances are reset
  to 0 too, so balance and (now empty) transactions stay consistent. Users,
  experiences, listings, etc. are left untouched.

  Run:  node src/scripts/clearUserActivity.js
*/
require('dotenv').config();
const { sequelize } = require('../config/database');
const { Booking, WalletTransaction, WishlistItem, User } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    const before = {
      bookings: await Booking.count(),
      transactions: await WalletTransaction.count(),
      wishlist: await WishlistItem.count(),
    };

    const bookings = await Booking.destroy({ where: {}, truncate: false });
    const transactions = await WalletTransaction.destroy({ where: {}, truncate: false });
    const wishlist = await WishlistItem.destroy({ where: {}, truncate: false });
    const [walletReset] = await User.update({ walletBalancePaise: 0 }, { where: {} });

    console.log('[clear] Deleted rows:', { bookings, transactions, wishlist });
    console.log('[clear] Wallet balances reset for users:', walletReset);
    console.log('[clear] Counts before:', before);
    console.log('[clear] Done — app + website are now fresh and in sync.');
    process.exit(0);
  } catch (err) {
    console.error('[clear] Failed:', err.message);
    process.exit(1);
  }
})();

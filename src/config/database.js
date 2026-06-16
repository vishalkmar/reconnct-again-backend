const { Sequelize } = require('sequelize');
require('dotenv').config();

/*
  Pool sizing tuned for the dev "open every page at once" pattern that was
  blowing through the previous max:10. Symptoms before this fix:

    SequelizeConnectionAcquireTimeoutError: Operation timeout

  Root causes covered here:
    1. Pool too small — Featured Retreats fan-out + admin tabs can trigger
       30+ concurrent queries on a single page load. We raise max to 25.
    2. Stale handles — MySQL closes idle connections (host-side `wait_timeout`)
       but sequelize-pool kept handing them out, leading to long hangs that
       eventually timed-out. We add `evict` so the pool actively drops idle
       sockets, and lower `idle` so sockets close before the server does.
    3. No retry on first-use failures — `retry.max` re-runs a query if the
       handed-out connection turns out to be dead.
    4. Long initial handshake — `dialectOptions.connectTimeout` gives the
       handshake 60 s instead of the 10 s default, so cold starts don't fail.

  Override any of these with env vars (`DB_POOL_MAX`, `DB_POOL_ACQUIRE`, …)
  if production needs different numbers.
*/
const intOr = (val, def) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: intOr(process.env.DB_PORT, 3306),
    dialect: 'mysql',
    logging: false,
    pool: {
      max:     intOr(process.env.DB_POOL_MAX,     25),
      min:     intOr(process.env.DB_POOL_MIN,     2),
      acquire: intOr(process.env.DB_POOL_ACQUIRE, 60000),
      idle:    intOr(process.env.DB_POOL_IDLE,    10000),
      // Run the eviction sweep every 5s — drops sockets that have been
      // idle past `idle` so we never hand out a dead handle.
      evict:   intOr(process.env.DB_POOL_EVICT,   5000),
    },
    // Re-run queries when the underlying connection turns out to be dead.
    retry: {
      max: 3,
      match: [
        /SequelizeConnectionError/,
        /SequelizeConnectionRefusedError/,
        /SequelizeHostNotFoundError/,
        /SequelizeHostNotReachableError/,
        /SequelizeInvalidConnectionError/,
        /SequelizeConnectionTimedOutError/,
        /SequelizeConnectionAcquireTimeoutError/,
        /TimeoutError/,
        /ETIMEDOUT/,
        /ECONNRESET/,
        /PROTOCOL_CONNECTION_LOST/,
      ],
    },
    dialectOptions: {
      connectTimeout: intOr(process.env.DB_CONNECT_TIMEOUT, 60000),
      // mysql2-specific keep-alive — pings the socket so middleboxes don't
      // silently drop it. Harmless when unsupported by the driver version.
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    },
    define: {
      timestamps: true,
      underscored: false,
    },
  }
);

const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log('[DB] MySQL connection established');
  } catch (error) {
    console.error('[DB] Unable to connect:', error.message);
    process.exit(1);
  }
};

module.exports = { sequelize, connectDB };

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

const apiRoutes = require('./routes');
const { notFound, errorHandler } = require('./middlewares/error.middleware');

const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Multiple client URLs support
const parseOrigins = (...values) =>
  values
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

const allowedOrigins = parseOrigins(
  process.env.CLIENT_URL,
  process.env.PWA_CLIENT_URL,
  'https://reconnct.com',
  'http://reconnct.com',
  'https://www.reconnct.com',
  'http://www.reconnct.com',
  'http://localhost:5173',
  'http://localhost:5174'
);

const corsOptions = {
  origin(origin, callback) {
    // Allow server-to-server, Postman, mobile app, same-origin, etc.
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // NOTE: X-User-Auth carries the public-site user token (kept separate from the
  // admin Authorization header). It MUST be allow-listed or the browser blocks
  // every signed-in user request (/me, /wishlist, …) — which silently logs the
  // user back out right after a successful login. X-Team-Auth is the same idea
  // for internal staff (BD/COPS/...) on the team portal, X-Supplier-Auth for a
  // supplier's own login on the Supplier Portal.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-User-Auth', 'X-Team-Auth', 'X-Supplier-Auth'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '10mb',
  })
);

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const uploadDir = process.env.UPLOAD_DIR || 'uploads';

app.use(
  `/${uploadDir}`,
  express.static(path.join(process.cwd(), uploadDir))
);

app.get('/', (req, res) =>
  res.json({
    success: true,
    name: 'Retreats by Traveon API',
    version: '1.0.0',
    allowedOrigins,
  })
);

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
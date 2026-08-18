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

// Behind Render's (and most PaaS) load balancer the real client IP arrives in
// X-Forwarded-For. Trusting exactly ONE hop lets express-rate-limit key on the
// true client IP instead of the proxy's — without trusting a spoofable chain of
// arbitrary length (which `true` would, and which the limiter itself warns
// against). Every rate limiter below depends on this being correct.
app.set('trust proxy', 1);

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

// Some links opened by the OS (the app's "Download voucher" button) carry the
// auth token in the URL query — those URLs land in the access log verbatim,
// leaking a working token to anyone who can read logs. Redact any sensitive
// query param before morgan formats the line. Purely a logging change; the
// request itself is untouched.
morgan.token('safeurl', (req) => String(req.originalUrl || req.url || '')
  .replace(/([?&])(token|access_token|api_key|apikey|password|otp)=[^&]*/gi, '$1$2=[redacted]'));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(':method :safeurl :status :response-time ms - :res[content-length]'));
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

// Health/identity ping. Deliberately minimal — the CORS allow-list and version
// were previously echoed here, which needlessly handed an attacker the exact
// set of trusted origins to target. Keep it a bare liveness signal.
app.get('/', (req, res) =>
  res.json({ success: true, name: 'Retreats by Traveon API' })
);

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
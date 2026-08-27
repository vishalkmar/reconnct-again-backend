const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

/*
  Service-account credentials for server-to-device push (Admin SDK). Same
  "only wired if configured" pattern as cloudinary.js — until these are set,
  sendPushToUser() is a silent no-op so the rest of the app never has to guard
  around missing push config.

  THREE ways to supply it, in this order, because the obvious one is the one
  that keeps failing on hosted platforms:

    1. FIREBASE_SERVICE_ACCOUNT_B64 — the same JSON, base64-encoded.
       PREFER THIS IN PRODUCTION. A service-account JSON contains a private
       key with literal "\n" sequences, and pasting it into a dashboard env
       field (Render, Railway, Heroku) mangles it often enough that "push is
       configured but nothing sends" is the normal outcome. Base64 has no
       newlines, no quotes and no escapes to lose.
         node -e "console.log(Buffer.from(require('fs').readFileSync('firebase-service-account.json')).toString('base64'))"

    2. FIREBASE_SERVICE_ACCOUNT — the raw JSON on one line. Works locally,
       where a .env file can hold it verbatim.

    3. FIREBASE_SERVICE_ACCOUNT_PATH, or ./firebase-service-account.json next
       to the backend — for a server with a real filesystem and a mounted
       secret.

  All three end up in the same place; whichever is present wins first.
*/
let app = null;
let lastError = null;

const DEFAULT_FILE = path.resolve(__dirname, '../../firebase-service-account.json');

/**
 * The raw JSON string from whichever source is configured, plus which one it
 * came from — the source name is reported by the admin test button, because
 * "push isn't working" on a two-server setup is nearly always a question of
 * WHICH server was asked.
 */
const readCredentials = () => {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64 && b64.trim()) {
    return { json: Buffer.from(b64.trim(), 'base64').toString('utf8'), source: 'FIREBASE_SERVICE_ACCOUNT_B64' };
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) return { json: raw.trim(), source: 'FIREBASE_SERVICE_ACCOUNT' };

  const file = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim() || DEFAULT_FILE;
  try {
    if (fs.existsSync(file)) {
      return { json: fs.readFileSync(file, 'utf8'), source: `file ${path.basename(file)}` };
    }
  } catch { /* unreadable — treated as not configured */ }

  return null;
};

const isConfigured = () => !!readCredentials();

/** Which of the three sources is in use — for diagnostics only. */
const configSource = () => {
  const found = readCredentials();
  return found ? found.source : null;
};

const getApp = () => {
  if (app) return app;
  const found = readCredentials();
  if (!found) return null;
  try {
    const credentials = JSON.parse(found.json);
    /*
      A private key that has been through a dashboard env field usually arrives
      with its newlines escaped one level too far ("\\n" instead of a real
      newline), and the SDK then fails at SIGNING time with a opaque error
      rather than here. Normalising it costs nothing and removes the single
      most common cause of "configured but never delivers".
    */
    if (typeof credentials.private_key === 'string') {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    app = admin.initializeApp({ credential: admin.cert(credentials) });
    lastError = null;
    return app;
  } catch (err) {
    lastError = err.message;
    console.warn('[FIREBASE] credentials from %s are invalid — push disabled: %s', found.source, err.message);
    return null;
  }
};

/** The reason push is unavailable, in words an admin can act on. */
const configError = () => {
  if (!isConfigured()) {
    return 'no Firebase service account on this server — set FIREBASE_SERVICE_ACCOUNT_B64 in its environment';
  }
  return lastError ? `Firebase credentials are invalid: ${lastError}` : null;
};

module.exports = {
  admin, getApp, isConfigured, configSource, configError,
};

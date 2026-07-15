const admin = require('firebase-admin');
require('dotenv').config();

// Service-account credentials for server-to-device push (Admin SDK). Same
// "only wired if configured" pattern as cloudinary.js — until these env vars
// are set, sendPush() below is a silent no-op so the rest of the app never
// has to guard around missing push config.
//
// Set FIREBASE_SERVICE_ACCOUNT to the full service-account JSON (one line,
// e.g. paste the downloaded file's contents as a single env var) — from
// Firebase Console → Project Settings → Service Accounts → Generate new
// private key.
let app = null;

const isConfigured = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;

const getApp = () => {
  if (app) return app;
  if (!isConfigured()) return null;
  try {
    const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    app = admin.initializeApp({ credential: admin.credential.cert(credentials) });
    return app;
  } catch (err) {
    console.warn('[FIREBASE] FIREBASE_SERVICE_ACCOUNT is set but invalid JSON — push disabled:', err.message);
    return null;
  }
};

module.exports = { admin, getApp, isConfigured };

const rateLimit = require('express-rate-limit');

/*
  Brute-force protection for credential endpoints.

  The global /api limiter (600 req / 15 min per IP) is fine for ordinary
  traffic but far too loose to stop password / OTP / reset-token guessing. This
  adds a TIGHT limiter meant only for the handful of endpoints where a wrong
  answer is an attack signal.

  Design choices that keep every legitimate flow working unchanged:
    • keyed by IP + the email in the body, so one attacker hammering one
      account can't lock out a different user who shares the same NAT/proxy IP;
    • skipSuccessfulRequests — a correct login / valid OTP does NOT count, so a
      real user who simply mistypes once or twice is never affected;
    • only failed attempts burn the budget, and the window resets on its own.
*/
const emailKey = (req) => {
  const email = String(req.body?.email || req.body?.identifier || '').toLowerCase().trim();
  // express-rate-limit resolves the client IP from req.ip (correct once
  // `trust proxy` is set on the app). Falls back gracefully if body has no email.
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  return email ? `${ip}:${email}` : ip;
};

// Credential guessing (admin / team / supplier password login, OTP verify,
// password reset submit). 10 wrong tries per 15 min per (IP + account).
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: emailKey,
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
});

// "Send me a link / code" endpoints (forgot-password, OTP request). Looser than
// credential guessing but still bounded so the mailer can't be used to flood an
// inbox or enumerate accounts. Both success and failure count here, because the
// endpoint deliberately returns success even for unknown emails.
const requestLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { success: false, message: 'Too many requests. Please wait a few minutes and try again.' },
});

// Coupon-code trial (app "Apply coupon"). A wrong code is an enumeration
// probe, so cap trials per user; genuine customers try a handful at most.
// Keyed by the signed-in user id (the route is authenticated) so one person
// guessing can't affect anyone else. NOTE: every trial counts — the endpoint
// deliberately answers HTTP 200 even for an invalid code (so the app can show
// the reason inline), so skipSuccessfulRequests would skip the very attacks we
// want to bound. 15 in 10 min is far more than any real checkout needs.
const couponTrialLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : (req.ip || 'unknown')),
  message: { success: false, message: 'Too many coupon attempts. Please wait a few minutes and try again.' },
});

module.exports = { credentialLimiter, requestLinkLimiter, couponTrialLimiter };

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { send } = require('../pwa/services/mailer');
const { emailShell, codeBox } = require('../utils/emailLayout');

/*
  Admin two-factor / MFA.

  After the password is correct, EVERY factor the admin has enabled must also
  pass before a real admin token is issued:
    • Email 2FA  — a 6-digit code is emailed to the admin's own address.
    • TOTP (MFA) — a 6-digit code from an authenticator app (Google
                   Authenticator, etc.) bound to a shared secret set up via QR.

  Between the password step and the factor step the client holds a short-lived
  "challenge" token (kind:'admin_2fa') — it proves the password already passed
  but is useless as an admin token, so it can't touch any protected route.
*/

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const CHALLENGE_TTL = '5m';
const ISSUER = 'reconnct Admin';
// Accept a code from the adjacent 30s window too, for clock drift.
const TOTP_WINDOW = 1;

// ── Challenge token (password passed, factor pending) ───────────────────────
const issueChallenge = (admin) => jwt.sign(
  { id: admin.id, kind: 'admin_2fa' },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: CHALLENGE_TTL },
);

const verifyChallenge = (token) => {
  const decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (decoded.kind !== 'admin_2fa') throw new Error('Not a 2FA challenge token');
  return decoded;
};

// Which factors this admin has switched on.
const enabledFactors = (admin) => {
  const f = [];
  if (admin.twoFactorEmailEnabled) f.push('email');
  if (admin.totpEnabled) f.push('totp');
  return f;
};
const has2FA = (admin) => enabledFactors(admin).length > 0;

// ── Email OTP ───────────────────────────────────────────────────────────────
const generateCode = () => String(crypto.randomInt(100000, 1000000));

// The inbox codes are delivered to — the dedicated 2FA email if set, else the
// login email.
const otpRecipient = (admin) => admin.twoFactorEmail || admin.email;

// A masked hint (t***@gmail.com) for the login screen.
const maskEmail = (e) => String(e || '').replace(/^(.).*(@.*)$/, '$1***$2');

// Create + store + email a fresh code to the admin's 2FA inbox.
const sendEmailOtp = async (admin) => {
  const code = generateCode();
  admin.twoFactorOtpHash = await bcrypt.hash(code, 8);
  admin.twoFactorOtpExpires = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
  admin.twoFactorOtpAttempts = 0;
  await admin.save();

  const html = emailShell({
    preheader: `Your admin sign-in code is ${code}`,
    bodyHtml: `
      <h2 style="margin:0 0 10px;color:#101828;font-size:19px;">Admin sign-in verification</h2>
      <p style="color:#374151;line-height:1.6;margin:0;">Enter this code to finish signing in to the admin panel.</p>
      ${codeBox(code)}
      <p style="color:#94a3b8;font-size:12px;margin:0;">Expires in ${OTP_TTL_MIN} minutes. If this wasn't you, change your admin password immediately.</p>
    `,
  });
  await send({ to: otpRecipient(admin), subject: `reconnct admin code: ${code}`, html, text: `Your admin code: ${code}` });
  return true;
};

// Verify a submitted email code against the stored hash (with expiry + attempts).
const verifyEmailOtp = async (admin, code) => {
  if (!admin.twoFactorOtpHash || !admin.twoFactorOtpExpires) return { ok: false, reason: 'No code was requested' };
  if (new Date(admin.twoFactorOtpExpires) < new Date()) return { ok: false, reason: 'Code expired' };
  if ((admin.twoFactorOtpAttempts || 0) >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'Too many attempts' };

  const matches = await bcrypt.compare(String(code || ''), admin.twoFactorOtpHash);
  if (!matches) {
    admin.twoFactorOtpAttempts = (admin.twoFactorOtpAttempts || 0) + 1;
    await admin.save();
    return { ok: false, reason: 'Incorrect code' };
  }
  // One-time: consume it.
  admin.twoFactorOtpHash = null;
  admin.twoFactorOtpExpires = null;
  admin.twoFactorOtpAttempts = 0;
  await admin.save();
  return { ok: true };
};

// ── TOTP (authenticator app) ────────────────────────────────────────────────
const checkTotp = (secret, code) => secret && speakeasy.totp.verify({
  secret, encoding: 'base32', token: String(code || '').trim(), window: TOTP_WINDOW,
});

// Begin setup: generate a PENDING base32 secret + the QR/otpauth for the admin
// to scan in their authenticator app.
const startTotpSetup = async (admin) => {
  const secret = speakeasy.generateSecret({ name: `${ISSUER} (${admin.email})`, issuer: ISSUER });
  admin.totpPendingSecret = secret.base32;
  await admin.save();
  const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
  return { otpauth: secret.otpauth_url, qrDataUrl, manualKey: secret.base32 };
};

// Finish setup: the admin proves they can generate a code → promote to active.
const confirmTotpSetup = async (admin, code) => {
  if (!admin.totpPendingSecret) return { ok: false, reason: 'Start the setup first' };
  if (!checkTotp(admin.totpPendingSecret, code)) return { ok: false, reason: 'That code is wrong — check the app and try again' };
  admin.totpSecret = admin.totpPendingSecret;
  admin.totpPendingSecret = null;
  admin.totpEnabled = true;
  await admin.save();
  return { ok: true };
};

const verifyTotp = (admin, code) => {
  if (!admin.totpSecret) return { ok: false, reason: 'Authenticator not set up' };
  return checkTotp(admin.totpSecret, code) ? { ok: true } : { ok: false, reason: 'Incorrect authenticator code' };
};

// ── Verify ALL enabled factors at the login step ────────────────────────────
const verifyAllFactors = async (admin, { emailCode, totpCode }) => {
  if (admin.twoFactorEmailEnabled) {
    const r = await verifyEmailOtp(admin, emailCode);
    if (!r.ok) return { ok: false, factor: 'email', reason: r.reason };
  }
  if (admin.totpEnabled) {
    const r = verifyTotp(admin, totpCode);
    if (!r.ok) return { ok: false, factor: 'totp', reason: r.reason };
  }
  return { ok: true };
};

module.exports = {
  issueChallenge,
  verifyChallenge,
  enabledFactors,
  has2FA,
  otpRecipient,
  maskEmail,
  sendEmailOtp,
  verifyEmailOtp,
  startTotpSetup,
  confirmTotpSetup,
  verifyTotp,
  verifyAllFactors,
};

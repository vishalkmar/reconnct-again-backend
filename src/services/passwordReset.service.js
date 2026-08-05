const crypto = require('crypto');
const { send } = require('../pwa/services/mailer');
const { emailShell, ctaButton, escapeHtml } = require('../utils/emailLayout');

/*
  Self-service forgot/reset password for internal Team Portal accounts and
  Suppliers. A raw one-time token goes in the emailed link; only its SHA-256
  hash is stored on the row, with a 1-hour expiry, so the DB never holds a
  usable token.
*/
const FRONTEND_BASE = (
  process.env.FRONTEND_URL
  || (process.env.TEAM_PORTAL_URL || '').replace(/\/team\/login\/?$/, '')
  || 'https://reconnct-again-frontend.vercel.app'
).replace(/\/$/, '');

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const makeToken = () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, expires: new Date(Date.now() + TOKEN_TTL_MS) };
};

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

// Build the reset URL the email links to. `portal` is 'team' | 'supplier'.
const resetUrl = (portal, email, raw) => `${FRONTEND_BASE}/${portal}/reset-password?token=${raw}&email=${encodeURIComponent(email)}`;

const sendResetEmail = async ({ to, name, url, roleLabel }) => {
  const html = emailShell({
    preheader: 'Reset your reconnct password',
    eyebrow: 'Password reset',
    heading: `Reset your password, ${escapeHtml(name || 'there')}`,
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        We received a request to reset the password for your
        <strong>${escapeHtml(roleLabel || 'account')}</strong> (${escapeHtml(to)}).
        Click the button below to choose a new password. This link expires in 1 hour.
      </p>
      ${ctaButton(url, 'Reset my password')}
      <p style="color:#6B7280;line-height:1.6;font-size:12px;margin:20px 0 0;">
        If the button doesn't work, copy this link into your browser:<br/>
        <span style="word-break:break-all;color:#2563eb;">${escapeHtml(url)}</span>
      </p>
      <p style="color:#6B7280;line-height:1.6;font-size:12px;margin:14px 0 0;">
        Didn't request this? You can safely ignore this email — your password stays the same.
      </p>
    `,
  });
  const text = [
    `Reset your reconnct password (${roleLabel || 'account'}):`,
    url,
    '',
    'This link expires in 1 hour. If you didn\'t request it, ignore this email.',
  ].join('\n');
  return send({ to, subject: 'Reset your reconnct password', html, text });
};

module.exports = { FRONTEND_BASE, makeToken, hashToken, resetUrl, sendResetEmail };

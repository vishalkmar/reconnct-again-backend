const crypto = require('crypto');
const { send } = require('../pwa/services/mailer');
const {
  escapeHtml: escape, emailShell, kvTable, ctaButton, calloutBox,
} = require('../utils/emailLayout');

/*
  A supplier never chooses their own password — whoever onboards them (BD or
  admin) never sees it either. It's generated HERE, hashed by the model hook,
  and the only place the plaintext ever appears is the welcome email to the
  supplier themselves.

  Where the supplier can sign in. Overridable per-environment; the defaults are
  the live web portal and the app's Play listing.
*/
const WEB_PORTAL_URL = process.env.SUPPLIER_PORTAL_URL || 'https://reconnct-again-frontend.vercel.app/supplier/login';
const APP_URL = process.env.APP_DOWNLOAD_URL || 'https://reconnct.app/app';

// Deliberately excludes look-alike characters (O/0, l/1/I) — this password is
// read off an email and typed by hand, so ambiguity costs support tickets.
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%&*?';

const pick = (set) => set[crypto.randomInt(set.length)];

/*
  12 characters with at least one of each class, then shuffled so the
  guaranteed characters aren't always in the same positions.
*/
const generatePassword = () => {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
};

/*
  "Welcome aboard" — account created, here are your credentials, here's where
  to sign in. Sent once, at creation.
*/
const sendSupplierWelcome = async ({ supplier, password }) => {
  if (!supplier?.email || !password) return;
  const name = supplier.companyName || supplier.supplierName || 'there';

  const html = emailShell({
    preheader: `Your reconnct Supplier Portal account is ready — sign in with ${supplier.email}`,
    eyebrow: 'Welcome to reconnct 🎉',
    heading: `You're all set, ${escape(name)}`,
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Congratulations — your <strong>Supplier Portal</strong> account has been created.
        You can list your experiences, track bookings and see your payouts from here on.
      </p>
      ${calloutBox('Your password', `<span style="font-family:monospace;letter-spacing:1px;">${escape(password)}</span>`, 'Please change it after your first sign-in')}
      ${kvTable([
    ['Email', escape(supplier.email)],
    ['Password', `<span style="font-family:monospace;">${escape(password)}</span>`],
  ])}
      <p style="color:#374151;line-height:1.6;margin:20px 0 6px;font-weight:700;">Sign in on the web</p>
      ${ctaButton(WEB_PORTAL_URL, 'Open the Supplier Portal')}
      <p style="color:#374151;line-height:1.6;margin:16px 0 6px;font-weight:700;">Or use the app</p>
      ${ctaButton(APP_URL, 'Get the reconnct app')}
      <p style="color:#6B7280;line-height:1.6;font-size:12px;margin:20px 0 0;">
        Keep this email safe — it's the only place your password is shown. If you didn't expect this,
        just reply and let us know.
      </p>
    `,
  });

  const text = [
    `Welcome to reconnct, ${name}!`,
    '',
    'Your Supplier Portal account has been created.',
    `Email: ${supplier.email}`,
    `Password: ${password}`,
    '',
    `Web portal: ${WEB_PORTAL_URL}`,
    `App: ${APP_URL}`,
    '',
    'Please change your password after signing in.',
  ].join('\n');

  return send({ to: supplier.email, subject: 'Welcome to reconnct — your Supplier Portal account is ready', html, text });
};

module.exports = { generatePassword, sendSupplierWelcome, WEB_PORTAL_URL, APP_URL };

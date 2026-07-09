const { send } = require('../pwa/services/mailer');
const { escapeHtml: escape, emailShell, codeBox, ctaButton } = require('../utils/emailLayout');

const sendUserOtp = ({ to, code, isNewUser }) => {
  const subject = `Your reconnct code: ${code}`;
  const html = emailShell({
    preheader: `Your verification code is ${code}`,
    bodyHtml: `
      <h2 style="margin:0 0 10px;color:#101828;font-size:19px;">${isNewUser ? 'Verify your email' : 'Welcome back!'}</h2>
      <p style="color:#374151;line-height:1.6;margin:0;">
        Use the one-time code below to ${isNewUser ? 'create your account' : 'sign in'}.
      </p>
      ${codeBox(code)}
      <p style="color:#94a3b8;font-size:12px;margin:0;">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.</p>
    `,
  });
  return send({ to, subject, html, text: `Your code: ${code}` });
};

const sendUserWelcome = ({ to, name }) => {
  const subject = 'Welcome to reconnct!';
  const safeName = escape(name || 'Traveller');
  const clientUrl = process.env.CLIENT_URL || '';
  const html = emailShell({
    preheader: `Your reconnct account is ready, ${safeName}`,
    bodyHtml: `
      <h2 style="margin:0 0 10px;color:#101828;font-size:19px;">Welcome, ${safeName}!</h2>
      <p style="color:#374151;line-height:1.6;margin:0 0 14px;">
        Your reconnct account is ready. Discover experiences and activities for every audience —
        solo, partner, family, friends and more — all in one place.
      </p>
      <ul style="color:#374151;line-height:1.7;margin:0 0 4px;padding-left:20px;">
        <li>Browse and book curated experiences near you</li>
        <li>Save your favourites to your wishlist</li>
        <li>Earn rewards every time a friend signs up using your referral code</li>
        <li>Track every booking and payment from your dashboard</li>
      </ul>
      ${clientUrl ? ctaButton(`${clientUrl}/dashboard`, 'Open your dashboard') : ''}
    `,
  });
  return send({ to, subject, html, text: `Welcome, ${name || 'Traveller'}! Your reconnct account is ready.` });
};

module.exports = { sendUserOtp, sendUserWelcome };

const { send } = require('../pwa/services/mailer');

const escape = (val) =>
  String(val ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );

const sendUserOtp = ({ to, code, isNewUser }) => {
  const subject = `Your Retreats by Traveon code: ${code}`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">${isNewUser ? 'Verify your email' : 'Welcome back!'}</h2>
      <p style="color:#374151;line-height:1.55;">
        Use the one-time code below to ${isNewUser ? 'create your account' : 'sign in'}.
      </p>
      <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f0fdfa;padding:18px 24px;text-align:center;border-radius:10px;color:#0f766e;margin:18px 0;">
        ${escape(code)}
      </div>
      <p style="color:#6b7280;font-size:13px;">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
    </div>
  `;
  return send({ to, subject, html, text: `Your code: ${code}` });
};

const sendUserWelcome = ({ to, name }) => {
  const subject = 'Welcome to Retreats by Traveon!';
  const safeName = escape(name || 'Traveller');
  const clientUrl = process.env.CLIENT_URL || '';
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">Welcome, ${safeName}!</h2>
      <p style="color:#374151;line-height:1.55;">
        Your Retreats by Traveon account is ready. Discover wellness retreats, curated hotels,
        events and add-on experiences — all in one place.
      </p>
      <ul style="color:#374151;line-height:1.6;padding-left:18px;">
        <li>Browse and book retreats, hotel rooms, events and add-ons</li>
        <li>Save your favourites to your wishlist</li>
        <li>Earn rewards every time a friend signs up using your referral code</li>
        <li>Track every booking and payment from your dashboard</li>
      </ul>
      ${clientUrl ? `<p style="margin-top:18px;"><a href="${escape(clientUrl)}/dashboard" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;">Open your dashboard</a></p>` : ''}
      <p style="color:#6b7280;font-size:13px;margin-top:18px;">
        Reply to this email any time — our team is happy to help.
      </p>
    </div>
  `;
  return send({ to, subject, html, text: `Welcome, ${name || 'Traveller'}! Your Retreats by Traveon account is ready.` });
};

module.exports = { sendUserOtp, sendUserWelcome };

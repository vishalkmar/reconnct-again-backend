const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok, fail } = require('../utils/response');
const { send } = require('../pwa/services/mailer');
const { escapeHtml: esc, emailShell, kvTable } = require('../utils/emailLayout');

// Where contact-form submissions are delivered. Prefer an explicit env, else
// the first site-info email, else the signed-contract notify address.
const resolveRecipient = async () => {
  if (process.env.CONTACT_TO) return process.env.CONTACT_TO;
  try {
    const row = await SiteSetting.findOne({ where: { key: 'site_info' } });
    const emails = row?.value?.emails;
    if (Array.isArray(emails) && emails[0]) return emails[0];
  } catch { /* ignore */ }
  return process.env.SIGNED_CONTRACT_NOTIFY_EMAIL || process.env.SMTP_USER || null;
};

// POST /api/contact  (public) — { name, email, phone, query }
const submit = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  const query = String(req.body.query || '').trim();

  if (!name) return fail(res, 'Please enter your name', 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 'Please enter a valid email', 400);
  if (!query) return fail(res, 'Please enter your message', 400);

  const to = await resolveRecipient();
  if (!to) return fail(res, 'Contact is not configured yet. Please email us directly.', 503);

  const html = emailShell({
    preheader: `New enquiry from ${name}`,
    eyebrow: 'Contact form',
    heading: 'New contact enquiry',
    ribbonBg: '#101828',
    ribbonFg: '#ffffff',
    bodyHtml: `
      ${kvTable([
        ['Name', esc(name)],
        ['Email', esc(email)],
        ['Phone', esc(phone) || '—'],
      ])}
      <p style="color:#374151;line-height:1.6;margin-top:16px;white-space:pre-wrap;">${esc(query)}</p>
    `,
    footerNote: 'Reply directly to this email to respond to the sender.',
  });

  try {
    await send({
      to,
      replyTo: email,
      subject: `New enquiry from ${name}`,
      html,
      text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n\n${query}`,
    });
  } catch (err) {
    console.error('[contact] email failed:', err.message);
    return fail(res, 'Could not send your message right now. Please try again shortly.', 502);
  }

  return ok(res, {}, 'Thanks! Your message has been sent — we’ll get back to you soon.');
});

module.exports = { submit };

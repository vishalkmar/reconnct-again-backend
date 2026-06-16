const asyncHandler = require('express-async-handler');
const { SiteSetting } = require('../models');
const { ok, fail } = require('../utils/response');
const { send } = require('../pwa/services/mailer');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">New contact enquiry</h2>
      <table style="border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 12px;color:#6b7280;">Name</td><td style="padding:6px 12px;font-weight:600;">${esc(name)}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Email</td><td style="padding:6px 12px;font-weight:600;">${esc(email)}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Phone</td><td style="padding:6px 12px;font-weight:600;">${esc(phone) || '—'}</td></tr>
      </table>
      <p style="color:#374151;line-height:1.55;margin-top:14px;white-space:pre-wrap;">${esc(query)}</p>
    </div>`;

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

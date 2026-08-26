const { send } = require('../pwa/services/mailer');
const { escapeHtml: esc, emailShell, ctaButton } = require('../utils/emailLayout');

/*
  The greeting email. Same shell as every other reconnct mail (emailLayout.js)
  so a Diwali wish still looks like the product, not like a blast from some
  marketing tool.

  Shape: festive banner image → greeting → the admin's message → up to three
  real experience cards (each one clickable, that's the whole point of the
  wish) → CTA → an unsubscribe line, which is not optional: this is marketing
  mail, and one-click opt-out is what keeps the sending domain healthy.
*/

const clientUrl = () => String(process.env.CLIENT_URL || '').replace(/\/$/, '');

const linkTo = (path, campaignSlug) => {
  const base = clientUrl();
  const clean = String(path || '/experiences');
  const sep = clean.includes('?') ? '&' : '?';
  // utm tags so the admin can tell campaign traffic apart in analytics.
  return `${base}${clean}${sep}utm_source=email&utm_medium=occasion&utm_campaign=${encodeURIComponent(campaignSlug)}`;
};

// One experience card — image, name, city. Table-based so Outlook behaves.
const experienceCard = (exp, campaignSlug) => {
  const href = linkTo(`/experiences/${exp.slug || exp.id}`, campaignSlug);
  const img = exp.mainImage
    ? `<img src="${esc(exp.mainImage)}" width="110" alt="" style="display:block;width:110px;height:80px;object-fit:cover;border-radius:10px;" />`
    : `<div style="width:110px;height:80px;border-radius:10px;background:#fff3d6;"></div>`;
  return `
    <a href="${esc(href)}" style="text-decoration:none;color:inherit;">
      <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #eef1f5;border-radius:12px;margin:0 0 10px;">
        <tr>
          <td style="padding:10px;width:130px;">${img}</td>
          <td style="padding:10px 12px 10px 0;vertical-align:middle;">
            <div style="font-weight:700;color:#101828;font-size:14px;line-height:1.35;">${esc(exp.name || 'Experience')}</div>
            ${exp.city ? `<div style="color:#64748b;font-size:12px;margin-top:3px;">${esc(exp.city)}</div>` : ''}
            <div style="color:#8a5a00;font-size:12px;font-weight:700;margin-top:6px;">View details →</div>
          </td>
        </tr>
      </table>
    </a>
  `;
};

/**
 * @param to          recipient email
 * @param name        recipient's name (already personalised into title/message)
 * @param campaign    the CampaignEvent row (the LEAD occasion when merged)
 * @param title       rendered title for this offset
 * @param message     rendered body for this offset
 * @param experiences Experience rows to showcase for the lead occasion
 * @param alsoToday   other occasions falling on the same morning, each with
 *                    its own wish and suggestions — see "Also today" below
 * @param unsubToken  opaque token for the one-click opt-out link
 */
const sendOccasionGreeting = ({
  to, name, campaign, title, message, experiences = [], alsoToday = [], unsubToken,
}) => {
  const cta = linkTo(campaign.ctaPath || '/experiences', campaign.slug);
  const banner = campaign.imageUrl
    ? `<img src="${esc(campaign.imageUrl)}" alt="${esc(campaign.name)}" style="display:block;width:100%;max-width:544px;border-radius:12px;margin:0 0 18px;" />`
    : '';
  const coupon = campaign.couponCode
    ? `<div style="margin:16px 0;padding:12px 14px;background:#fff8e6;border:1px dashed #f0c14b;border-radius:10px;color:#8a5a00;font-size:14px;">
         Use code <strong style="letter-spacing:1px;">${esc(campaign.couponCode)}</strong> at checkout
       </div>`
    : '';
  const cards = experiences.length
    ? `<div style="margin:18px 0 4px;">
         <div style="font-size:13px;font-weight:700;color:#101828;margin:0 0 10px;">Handpicked for the occasion</div>
         ${experiences.slice(0, 3).map((e) => experienceCard(e, campaign.slug)).join('')}
       </div>`
    : '';

  /*
    "Also today" — when two occasions land on the same morning we send ONE
    email instead of two (see campaignSweep's grouping). The second occasion
    is not demoted to a footnote: it gets its own wish and its own suggested
    experiences, just under the lead one.
  */
  const also = alsoToday.length
    ? `<div style="margin:22px 0 4px;padding-top:18px;border-top:1px solid #eef1f5;">
         ${alsoToday.map((extra) => `
           <div style="margin:0 0 16px;">
             <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#94a3b8;margin:0 0 4px;">Also today</div>
             <div style="font-weight:700;color:#101828;font-size:16px;margin:0 0 6px;">${esc(extra.title || extra.name)}</div>
             ${extra.message ? `<p style="color:#374151;line-height:1.6;margin:0 0 10px;white-space:pre-line;">${esc(extra.message)}</p>` : ''}
             ${(extra.experiences || []).slice(0, 2).map((e) => experienceCard(e, campaign.slug)).join('')}
           </div>
         `).join('')}
       </div>`
    : '';
  const unsub = unsubToken
    ? `<div style="margin-top:14px;color:#a1a8b3;font-size:11px;">
         Don't want festival &amp; weekend greetings?
         <a href="${esc(`${clientUrl()}/unsubscribe?token=${unsubToken}`)}" style="color:#64748b;">Unsubscribe</a>.
       </div>`
    : '';

  // Subject leads with the main occasion; a merged send names the other one
  // too, so the inbox line itself shows both wishes.
  const subject = alsoToday.length
    ? `${title} — and happy ${alsoToday.map((e) => e.name).join(' & ')}!`
    : title;

  const html = emailShell({
    preheader: message ? String(message).slice(0, 120) : title,
    bodyHtml: `
      ${banner}
      <h2 style="margin:0 0 10px;color:#101828;font-size:20px;line-height:1.3;">${esc(title)}</h2>
      ${message ? `<p style="color:#374151;line-height:1.65;margin:0;white-space:pre-line;">${esc(message)}</p>` : ''}
      ${coupon}
      ${cards}
      ${also}
      ${ctaButton(cta, campaign.ctaLabel || 'Explore experiences')}
      ${unsub}
    `,
    footerNote: 'You are receiving this because you have a reconnct account.',
  });

  const text = `${subject}\n\n${message || ''}\n\n${cta}`;
  return send({ to, subject, html, text });
};

module.exports = { sendOccasionGreeting, linkTo };

const { send } = require('../pwa/services/mailer');
const { escapeHtml: esc, emailShell, ctaButton } = require('../utils/emailLayout');
const { stageBadge, isRampOffset, dayOfSell } = require('./campaignCountdown.service');
const { prettyKey } = require('../utils/istDate');

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

/*
  This server's own public base, for the tracking pixels. Same env var the
  payment callbacks use, so there is one answer to "where does this backend
  live" rather than two that can disagree. Empty (unset) simply means no
  tracking markup is emitted — the mail still sends, it just is not measured.
*/
const apiUrl = () => String(process.env.APP_URL || '').replace(/\/$/, '');

const trackUrl = (kind, token, extra = '') =>
  (apiUrl() && token
    ? `${apiUrl()}/api/campaigns/t/${kind}.gif?t=${encodeURIComponent(token)}${extra}`
    : '');

/*
  Every destination link in a greeting goes through /open.html — the
  app-or-browser chooser (frontend/public/open.html) — rather than straight to
  the page.

  The reason is that these mails are the one place we reach someone who has
  the app installed but is reading on a device that will happily open the
  website instead. A tap from a Diwali mail should be able to land in the app,
  where they are already signed in and their bookings live; and if they do not
  have it, that same tap is the best install prompt we will ever get.

  The chooser is a static file, so this adds no redirect hop through the API
  and no dependency on the backend being up for an email link to work. The
  real destination rides in `to` as a site-relative path — the chooser
  validates it before using it, since it arrives from a mail client.

  NOT routed through here: the unsubscribe link. Putting an app upsell in
  front of someone trying to leave is exactly the behaviour that gets a
  sending domain reported, so that one stays direct.
*/
const linkTo = (path, campaignSlug, { trackToken = null, kind = 'browse' } = {}) => {
  const base = clientUrl();
  const clean = String(path || '/experiences');
  const sep = clean.includes('?') ? '&' : '?';
  // utm tags so the admin can tell campaign traffic apart in analytics.
  const dest = `${clean}${sep}utm_source=email&utm_medium=occasion&utm_campaign=${encodeURIComponent(campaignSlug)}`;

  /*
    The chooser is a STATIC file and cannot know where the API lives, so the
    click pixel arrives fully-formed in `trk`. It also means the two never
    drift: change APP_URL and every future link follows, with nothing to
    redeploy on the frontend.

    `kind` is what separates the metric that matters from the one that does
    not — 'experience' is somebody who tapped a suggested experience, 'browse'
    is the generic CTA at the bottom.
  */
  const trk = trackUrl('click', trackToken, `&k=${kind}`);
  const parts = [`to=${encodeURIComponent(dest)}`];
  if (trk) parts.push(`trk=${encodeURIComponent(trk)}`);
  return `${base}/open.html?${parts.join('&')}`;
};

// One experience card — image, name, city. Table-based so Outlook behaves.
const experienceCard = (exp, campaignSlug, trackToken) => {
  const href = linkTo(`/experiences/${exp.slug || exp.id}`, campaignSlug, {
    trackToken, kind: 'experience',
  });
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
 * @param offsetDay   which beat of the run-up this is (-7 … 0)
 * @param occurrenceDate  the occasion's own date, for the countdown ribbon
 * @param trackToken  signed handle for THIS dispatch row — drives the open
 *                    pixel and the per-link click tracking. Omit it (a test
 *                    send) and the mail simply goes out unmeasured.
 * @param unsubToken  opaque token for the one-click opt-out link
 */
const sendOccasionGreeting = ({
  to, name, campaign, title, message, experiences = [], alsoToday = [],
  offsetDay = 0, occurrenceDate = null, trackToken = null, unsubToken,
}) => {
  const cta = linkTo(campaign.ctaPath || '/experiences', campaign.slug, { trackToken, kind: 'browse' });
  const banner = campaign.imageUrl
    ? `<img src="${esc(campaign.imageUrl)}" alt="${esc(campaign.name)}" style="display:block;width:100%;max-width:544px;border-radius:12px;margin:0 0 18px;" />`
    : '';
  const coupon = campaign.couponCode
    ? `<div style="margin:16px 0;padding:12px 14px;background:#fff8e6;border:1px dashed #f0c14b;border-radius:10px;color:#8a5a00;font-size:14px;">
         Use code <strong style="letter-spacing:1px;">${esc(campaign.couponCode)}</strong> at checkout
       </div>`
    : '';
  /*
    Two different mails share this template, and they must not look alike.

    A RUN-UP mail ("3 days to go") is about a deadline: the most useful thing
    on the page is how long is left and which day it lands on, so that goes
    above the headline as a countdown ribbon, carrying the real date because
    "3 days" alone still needs a calendar.

    The DAY-OF mail is about the day. It gets a festive band instead, the wish
    on its own, and only then — below a divider — the one line that sells
    today. Same shell, deliberately different page.
  */
  const isDayOf = !isRampOffset(offsetDay);

  const ribbon = !isDayOf
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 14px;">
         <tr>
           <td style="background:#fff8e6;border:1px solid #f0c14b;border-radius:999px;padding:6px 14px;color:#8a5a00;font-size:12px;font-weight:700;letter-spacing:.3px;">
             ⏳ ${esc(stageBadge(offsetDay))}${occurrenceDate ? ` &middot; ${esc(campaign.name)} on ${esc(prettyKey(occurrenceDate))}` : ''}
           </td>
         </tr>
       </table>`
    /*
      The day itself gets a FESTIVE band, not a countdown ribbon. Four mails
      have already arrived with a stopwatch and a deadline on them; the fifth
      is the one that is actually about the day, and it has to look like it
      the moment the inbox preview renders — a warm band, the occasion's name,
      no numbers counting down to anything.
    */
    : `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:0 0 16px;">
         <tr>
           <td align="center" style="background:#fff3d6;border:1px solid #f0c14b;border-radius:12px;padding:10px 14px;color:#8a5a00;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">
             🎉 ${esc(campaign.name)} &middot; today
           </td>
         </tr>
       </table>`;

  /*
    Splitting the wish from the sell.

    renderCopy() appends the generated day-of selling line to the wish as a
    second paragraph. The email pulls it back off so the two can be laid out
    apart — greeting, divider, then the offer — which is the whole reason the
    day-of mail reads differently from the four that preceded it.

    Finding it by index rather than at the end matters: the sell line is not
    always last. Bhai Dooj falls three days after Diwali, so Diwali morning
    merges Diwali's day-of wish with Bhai Dooj's "3 days to go" — and the
    merge appends "Coming up: Bhai Dooj in 3 days" AFTER the sell line.
    Splitting on the index keeps all three parts, in order, in their right
    places; anything trailing the sell line rides along beneath it.

    indexOf() is the whole test, so there is no flag to keep in sync and no
    way for the two to disagree. When it does not match — the admin wrote
    their own day-of message, so nothing was ever appended — the message
    simply renders whole, exactly as they wrote it.
  */
  const sell = isDayOf ? dayOfSell(campaign) : null;
  const sellAt = sell && message ? String(message).indexOf(sell.line) : -1;
  const hasSell = sellAt >= 0;
  const wishText = hasSell ? String(message).slice(0, sellAt).trimEnd() : message;
  const afterSell = hasSell ? String(message).slice(sellAt + sell.line.length).trim() : '';

  const sellBlock = hasSell
    ? `<div style="margin:20px 0 0;padding-top:16px;border-top:1px solid #eef1f5;">
         <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#94a3b8;margin:0 0 6px;">${esc(sell.label)}</div>
         <p style="color:#374151;line-height:1.65;margin:0;white-space:pre-line;">${esc(sell.line)}</p>
         ${afterSell ? `<p style="color:#374151;line-height:1.65;margin:10px 0 0;white-space:pre-line;">${esc(afterSell)}</p>` : ''}
       </div>`
    : '';

  const cards = experiences.length
    ? `<div style="margin:18px 0 4px;">
         <div style="font-size:13px;font-weight:700;color:#101828;margin:0 0 10px;">
           ${isDayOf ? 'Still bookable today' : 'Handpicked for the occasion'}
         </div>
         ${experiences.slice(0, 3).map((e) => experienceCard(e, campaign.slug, trackToken)).join('')}
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
             <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#94a3b8;margin:0 0 4px;">${esc(extra.offsetDay ? `Coming up · ${extra.stage || ''}` : 'Also today')}</div>
             <div style="font-weight:700;color:#101828;font-size:16px;margin:0 0 6px;">${esc(extra.title || extra.name)}</div>
             ${extra.message ? `<p style="color:#374151;line-height:1.6;margin:0 0 10px;white-space:pre-line;">${esc(extra.message)}</p>` : ''}
             ${(extra.experiences || []).slice(0, 2).map((e) => experienceCard(e, campaign.slug, trackToken)).join('')}
           </div>
         `).join('')}
       </div>`
    : '';
  /*
    The open pixel. Last element in the body and 1x1, so a client that blocks
    images shows nothing rather than a broken-image icon. Deliberately the
    softest number in the dashboard — Gmail proxies images and Apple Mail
    pre-fetches them, so this over-counts and is labelled that way wherever
    it is displayed.
  */
  const openBeacon = trackUrl('open', trackToken);
  const openPixel = openBeacon
    ? `<img src="${esc(openBeacon)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`
    : '';

  const unsub = unsubToken
    ? `<div style="margin-top:14px;color:#a1a8b3;font-size:11px;">
         Don't want festival &amp; weekend greetings?
         <a href="${esc(`${clientUrl()}/unsubscribe?token=${unsubToken}`)}" style="color:#64748b;">Unsubscribe</a>.
       </div>`
    : '';

  // Subject leads with the main occasion; a merged send names the other one
  // too, so the inbox line itself shows both wishes.
  const sameDay = alsoToday.filter((e) => !e.offsetDay);
  const subject = sameDay.length
    ? `${title} — and happy ${sameDay.map((e) => e.name).join(' & ')}!`
    : title;

  const html = emailShell({
    // The inbox preview line. On the day that is the WISH, not the sales
    // line stapled to the end of it — the preview is the greeting.
    preheader: wishText ? String(wishText).slice(0, 120) : title,
    bodyHtml: `
      ${banner}
      ${ribbon}
      <h2 style="margin:0 0 10px;color:#101828;font-size:20px;line-height:1.3;">${esc(title)}</h2>
      ${wishText ? `<p style="color:#374151;line-height:1.65;margin:0;white-space:pre-line;">${esc(wishText)}</p>` : ''}
      ${sellBlock}
      ${coupon}
      ${cards}
      ${also}
      ${ctaButton(cta, campaign.ctaLabel || 'Explore experiences')}
      ${unsub}
      ${openPixel}
    `,
    footerNote: 'You are receiving this because you have a reconnct account.',
  });

  const text = `${subject}\n\n${message || ''}\n\n${cta}`;
  return send({ to, subject, html, text });
};

module.exports = { sendOccasionGreeting, linkTo };

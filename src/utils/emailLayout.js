/**
 * Shared, inline-styled email layout — every transactional email in this
 * codebase (OTP, welcome, booking vouchers, reminders, PWA onboarding, admin
 * notes) renders through this so they all look like one product instead of a
 * dozen ad-hoc <div>s. Inline styles + table-safe markup only, no external
 * CSS/fonts/flexbox — Outlook/Gmail/Apple Mail all render this consistently.
 *
 * Brand palette matches the actual app theme (amber/gold + dark navy), not
 * the old "Retreats by Traveon" teal this file replaces.
 */

const BRAND = '#F9B402'; // amber — app's brand accent
const INK = '#101828'; // near-black navy for headings
const MUTED = '#64748b';
const BORDER = '#eef1f5';
const BG = '#f5f6f8';

const escapeHtml = (val) =>
  String(val ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );

/**
 * The outer shell every email uses: light-gray backdrop, a white rounded
 * card, a small wordmark header, the caller's body HTML, and a consistent
 * footer. `eyebrow`/`heading` render as an optional colored ribbon at the
 * top of the card (used for "Booking confirmed", "New booking", reminders,
 * OTP, etc.) — omit both for a plain card (used by simple notices).
 */
const emailShell = ({
  preheader = '',
  eyebrow,
  heading,
  ribbonBg = BRAND,
  ribbonFg = '#101010',
  bodyHtml,
  footerNote = 'Need help? Just reply to this email — our team is happy to assist.',
  width = 600,
}) => `
<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:${BG};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>` : ''}
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:${BG};padding:32px 12px;">
    <div style="max-width:${width}px;margin:0 auto;">
      <!-- Wordmark -->
      <div style="text-align:center;margin-bottom:18px;">
        <span style="font-size:20px;font-weight:800;color:${INK};letter-spacing:0.2px;">reconnct</span>
      </div>
      <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(16,24,40,0.08);">
        ${heading ? `
          <div style="background:${ribbonBg};padding:22px 28px;color:${ribbonFg};">
            ${eyebrow ? `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.85;">${escapeHtml(eyebrow)}</div>` : ''}
            <div style="font-weight:800;font-size:19px;margin-top:4px;line-height:1.3;">${heading}</div>
          </div>
        ` : ''}
        <div style="padding:26px 28px;">
          ${bodyHtml}
        </div>
        <div style="padding:16px 28px;background:#fafbfc;border-top:1px solid ${BORDER};color:${MUTED};font-size:12px;line-height:1.6;">
          ${footerNote}
          <div style="margin-top:8px;color:#94a3b8;">— Team reconnct</div>
        </div>
      </div>
      <div style="text-align:center;color:#a1a8b3;font-size:11px;margin-top:16px;">
        This is an automated message from reconnct.
      </div>
    </div>
  </div>
</body>
</html>
`;

// Big, centered code display (OTP).
const codeBox = (code) => `
  <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#fff8e6;color:#8a5a00;padding:18px 24px;text-align:center;border-radius:12px;margin:18px 0;">
    ${escapeHtml(code)}
  </div>
`;

// Amber CTA button.
const ctaButton = (href, label) => `
  <table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0;">
    <tr><td style="background:${BRAND};border-radius:10px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 22px;color:#101010;font-weight:700;font-size:14px;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>
`;

// Label/value key rows (booking details, contract details, etc.).
const kvTable = (rows) => `
  <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px;">
    ${rows.filter(Boolean).map(([k, v]) => `
      <tr>
        <td style="padding:9px 0;color:${MUTED};width:38%;border-bottom:1px solid ${BORDER};vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:9px 0;color:${INK};font-weight:600;border-bottom:1px solid ${BORDER};">${v}</td>
      </tr>
    `).join('')}
  </table>
`;

// Highlighted callout box (Property ID, base amount, etc.).
const calloutBox = (label, value, sub) => `
  <div style="background:#fff8e6;border-radius:12px;padding:16px 20px;margin:16px 0;text-align:center;">
    ${label ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#8a5a00;margin-bottom:4px;">${escapeHtml(label)}</div>` : ''}
    <div style="font-size:20px;font-weight:800;color:${INK};letter-spacing:0.5px;">${value}</div>
    ${sub ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">${escapeHtml(sub)}</div>` : ''}
  </div>
`;

module.exports = {
  BRAND, INK, MUTED, BORDER, BG, escapeHtml, emailShell, codeBox, ctaButton, kvTable, calloutBox,
};

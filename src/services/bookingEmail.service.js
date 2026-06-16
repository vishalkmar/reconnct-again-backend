const { send } = require('../pwa/services/mailer');
const { fromPaise } = require('./booking.service');

const escape = (val) =>
  String(val ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );

const fmtMoney = (paise, currency = 'INR') => {
  const value = fromPaise(paise);
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
};

const typeLabel = (t) => ({
  package: 'Retreat',
  room: 'Hotel Room',
  event: 'Event',
  addon: 'Add-on Activity',
})[t] || 'Booking';

/**
 * Build the voucher HTML embedded in the confirmation email. Kept as plain
 * inline styles (no external CSS) so it renders identically across Gmail,
 * Outlook, Apple Mail and the Brevo preview.
 */
const buildVoucherHtml = (booking) => {
  const item = booking.itemSnapshot || {};
  const scheduleLine = booking.scheduledEndAt
    ? `${fmtDate(booking.scheduledFor)} → ${fmtDate(booking.scheduledEndAt)}`
    : fmtDate(booking.scheduledFor);

  const rows = [
    ['When', scheduleLine],
    [booking.itemType === 'room' ? 'Nights' : 'Duration', `${booking.units} ${booking.itemType === 'room' ? (booking.units === 1 ? 'night' : 'nights') : (booking.units === 1 ? 'day' : 'days')}`],
    ['Guests', booking.guestCount],
    ['Lead traveller', `${escape(booking.guestName)} · ${escape(booking.guestPhone)}`],
  ];
  if (item.location) rows.push(['Location', escape(item.location)]);
  if (item.hotel?.name) rows.push(['Hotel', escape(item.hotel.name)]);
  if (booking.specialRequests) rows.push(['Special requests', escape(booking.specialRequests)]);

  const pricingRows = [
    [`Subtotal (${booking.units || booking.guestCount} × ${fmtMoney(booking.unitPricePaise, booking.currency)})`, fmtMoney(booking.subtotalPaise, booking.currency)],
    ['Taxes', fmtMoney(booking.taxPaise, booking.currency)],
  ];
  if (booking.walletDiscountPaise > 0) pricingRows.push(['Wallet credit', `− ${fmtMoney(booking.walletDiscountPaise, booking.currency)}`]);
  if (booking.couponDiscountPaise > 0) pricingRows.push([`Coupon ${booking.couponCode || ''}`.trim(), `− ${fmtMoney(booking.couponDiscountPaise, booking.currency)}`]);

  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f5f6f8;padding:32px 12px;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
        <!-- Ribbon -->
        <div style="background:linear-gradient(135deg,#0f766e,#065f46);padding:24px 28px;color:#fff;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.9;">Booking confirmed</div>
          <div style="font-family:Menlo,Consolas,monospace;font-weight:700;font-size:22px;margin-top:4px;letter-spacing:1px;">${escape(booking.bookingCode)}</div>
          <div style="font-size:12px;opacity:.9;margin-top:2px;">${escape(typeLabel(booking.itemType))}</div>
        </div>

        <!-- Item card -->
        <div style="padding:20px 28px;border-bottom:1px solid #eef2f7;">
          ${item.image ? `
            <img src="${escape(item.image)}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:10px;margin-bottom:14px;" />
          ` : ''}
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#0f766e;">${escape(typeLabel(booking.itemType))}</div>
          <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:4px;line-height:1.3;">${escape(item.name || 'Booking')}</div>
          ${item.location ? `<div style="font-size:13px;color:#64748b;margin-top:4px;">📍 ${escape(item.location)}</div>` : ''}
        </div>

        <!-- Details -->
        <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">
          ${rows.map(([k, v]) => `
            <tr>
              <td style="padding:10px 28px;color:#64748b;font-size:13px;width:36%;border-bottom:1px solid #f1f5f9;">${escape(k)}</td>
              <td style="padding:10px 28px;color:#0f172a;font-size:14px;font-weight:600;border-bottom:1px solid #f1f5f9;">${v}</td>
            </tr>
          `).join('')}
        </table>

        <!-- Pricing -->
        <div style="padding:18px 28px;background:#f8fafc;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:8px;">Payment summary</div>
          <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13px;">
            ${pricingRows.map(([k, v]) => `
              <tr>
                <td style="padding:4px 0;color:#475569;">${escape(k)}</td>
                <td style="padding:4px 0;text-align:right;color:#0f172a;font-weight:500;">${v}</td>
              </tr>
            `).join('')}
            <tr>
              <td style="padding:10px 0 0 0;border-top:1px solid #e2e8f0;color:#0f172a;font-weight:700;font-size:15px;">Total paid</td>
              <td style="padding:10px 0 0 0;border-top:1px solid #e2e8f0;text-align:right;color:#0f766e;font-weight:800;font-size:18px;">${fmtMoney(booking.totalPaise, booking.currency)}</td>
            </tr>
          </table>
          ${booking.paymentId ? `<div style="font-size:11px;color:#64748b;margin-top:10px;">Payment reference: <span style="font-family:Menlo,Consolas,monospace;">${escape(booking.paymentId)}</span></div>` : ''}
        </div>

        <!-- Footer -->
        <div style="padding:18px 28px;font-size:12px;color:#64748b;line-height:1.6;">
          Keep this voucher handy — you'll need to show the booking code at check-in.
          Need help? Just reply to this email and our team will get back to you.
          <div style="margin-top:10px;">— Team Retreats by Traveon</div>
        </div>
      </div>
    </div>
  `;
};

const sendBookingConfirmation = async ({ booking }) => {
  if (!booking?.guestEmail) return;
  const html = buildVoucherHtml(booking);
  const subject = `Booking confirmed: ${booking.itemSnapshot?.name || 'Your booking'} (${booking.bookingCode})`;
  const text = [
    `Booking confirmed — ${booking.bookingCode}`,
    booking.itemSnapshot?.name,
    `When: ${fmtDate(booking.scheduledFor)}${booking.scheduledEndAt ? ' → ' + fmtDate(booking.scheduledEndAt) : ''}`,
    `Guests: ${booking.guestCount}`,
    `Total paid: ${fmtMoney(booking.totalPaise, booking.currency)}`,
  ].filter(Boolean).join('\n');

  return send({ to: booking.guestEmail, subject, html, text });
};

module.exports = { sendBookingConfirmation, buildVoucherHtml };

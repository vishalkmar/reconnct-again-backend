const { send } = require('../pwa/services/mailer');
const { fromPaise } = require('./booking.service');
const { buildBookingVoucherPdf } = require('./bookingVoucherPdf.service');
const { sendPushToUser } = require('./push.service');
const {
  escapeHtml: escape, emailShell, kvTable, calloutBox,
} = require('../utils/emailLayout');

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
  experience: 'Experience',
})[t] || 'Booking';

/**
 * Build the voucher HTML embedded in the confirmation email. Renders through
 * the shared emailShell so it looks consistent with every other reconnct
 * email (inline styles only — no external CSS — so it renders identically
 * across Gmail, Outlook, Apple Mail and the Brevo preview).
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

  const bodyHtml = `
    ${item.image ? `<img src="${escape(item.image)}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:10px;margin-bottom:16px;" />` : ''}
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#b45309;">${escape(typeLabel(booking.itemType))}</div>
    <div style="font-size:20px;font-weight:800;color:#101828;margin:4px 0 4px;line-height:1.3;">${escape(item.name || 'Booking')}</div>
    ${item.location ? `<div style="font-size:13px;color:#64748b;margin-bottom:16px;">📍 ${escape(item.location)}</div>` : '<div style="margin-bottom:8px;"></div>'}

    ${kvTable(rows)}

    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #eef1f5;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:10px;">Payment summary</div>
      <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13px;">
        ${pricingRows.map(([k, v]) => `
          <tr>
            <td style="padding:4px 0;color:#475569;">${escape(k)}</td>
            <td style="padding:4px 0;text-align:right;color:#101828;font-weight:500;">${v}</td>
          </tr>
        `).join('')}
        <tr>
          <td style="padding:10px 0 0 0;border-top:1px solid #e2e8f0;color:#101828;font-weight:700;font-size:15px;">Total paid</td>
          <td style="padding:10px 0 0 0;border-top:1px solid #e2e8f0;text-align:right;color:#b45309;font-weight:800;font-size:18px;">${fmtMoney(booking.totalPaise, booking.currency)}</td>
        </tr>
      </table>
      ${booking.paymentId ? `<div style="font-size:11px;color:#94a3b8;margin-top:10px;">Payment reference: <span style="font-family:Menlo,Consolas,monospace;">${escape(booking.paymentId)}</span></div>` : ''}
    </div>
  `;

  return emailShell({
    preheader: `Your booking ${booking.bookingCode} is confirmed`,
    eyebrow: 'Booking confirmed',
    heading: `<span style="font-family:Menlo,Consolas,monospace;letter-spacing:1px;">${escape(booking.bookingCode)}</span>`,
    bodyHtml,
    footerNote: "Keep this voucher handy — you'll need to show the booking code at check-in. Need help? Just reply to this email and our team will get back to you.",
  });
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

  // PDF voucher attachment — best-effort. A PDF layout bug should never stop
  // the confirmation email itself from going out.
  let attachments;
  try {
    const pdf = await buildBookingVoucherPdf(booking);
    attachments = [{ filename: `voucher-${booking.bookingCode}.pdf`, content: pdf }];
  } catch (err) {
    console.error('[bookingEmail] voucher PDF generation failed:', err.message);
  }

  return send({ to: booking.guestEmail, subject, html, text, attachments });
};

/**
 * Voucher-style email for the HOST — same visual language as the guest's
 * confirmation, but the payment block shows only the BASE amount (subtotal),
 * never GST/convenience fee/discounts, since those are platform-side and not
 * the host's payout basis.
 */
const buildHostVoucherHtml = (booking, exp) => {
  const item = booking.itemSnapshot || {};
  const scheduleLine = booking.scheduledEndAt
    ? `${fmtDate(booking.scheduledFor)} → ${fmtDate(booking.scheduledEndAt)}`
    : fmtDate(booking.scheduledFor);
  const baseAmount = fmtMoney(booking.subtotalPaise, booking.currency);

  const rows = [
    ['When', scheduleLine],
    ['Guests', booking.guestCount],
    ['Guest name', escape(booking.guestName)],
    ['Guest email', escape(booking.guestEmail)],
    ['Guest phone', escape(booking.guestPhone)],
  ];
  if (booking.specialRequests) rows.push(['Special requests', escape(booking.specialRequests)]);

  const bodyHtml = `
    ${item.image ? `<img src="${escape(item.image)}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:10px;margin-bottom:16px;" />` : ''}
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#b45309;">Experience</div>
    <div style="font-size:20px;font-weight:800;color:#101828;margin:4px 0 16px;line-height:1.3;">${escape(exp.name)}</div>

    ${kvTable(rows)}

    <div style="margin-top:20px;">
      ${calloutBox('Base amount', baseAmount, 'Excludes GST and platform convenience fee.')}
    </div>
  `;

  return emailShell({
    preheader: `New booking on ${exp.name} — ${booking.bookingCode}`,
    eyebrow: 'New booking on your listing',
    heading: `<span style="font-family:Menlo,Consolas,monospace;letter-spacing:1px;">${escape(booking.bookingCode)}</span>`,
    bodyHtml,
    footerNote: `Open the reconnct app → Switch to Hosting → My Listings → ${escape(exp.name)} to see this booking and everyone else who's booked.`,
  });
};

/**
 * Tell the HOST (the User who owns the Experience via ownerUserId) that one
 * of their listings just got booked. No-op for admin-authored experiences
 * (ownerUserId null) or non-experience bookings (rooms/packages/events don't
 * have a host account yet). Fire-and-forget, same as sendBookingConfirmation.
 */
const notifyHostOfBooking = async ({ booking }) => {
  if (!booking || booking.itemType !== 'experience') return;
  const { Experience, User } = require('../models');
  const exp = await Experience.findByPk(booking.itemId);
  if (!exp || !exp.ownerUserId) return;
  const host = await User.findByPk(exp.ownerUserId);
  if (!host) return;

  sendPushToUser(host.id, {
    title: 'New booking!',
    body: `${booking.guestName || 'A guest'} just booked ${exp.name}.`,
    data: { kind: 'host_booking', bookingId: booking.id, isHostBooking: 'true' },
  }).catch(() => {});

  if (!host.email) return;

  const subject = `New booking on ${exp.name} — ${booking.bookingCode}`;
  const html = buildHostVoucherHtml(booking, exp);
  const text = `New booking on ${exp.name} (${booking.bookingCode}) — guest ${booking.guestName || 'Guest'} (${booking.guestEmail || ''}, ${booking.guestPhone || ''}), base amount ${fmtMoney(booking.subtotalPaise, booking.currency)}.`;

  let attachments;
  try {
    const pdf = await buildBookingVoucherPdf(booking, { hostView: true });
    attachments = [{ filename: `host-voucher-${booking.bookingCode}.pdf`, content: pdf }];
  } catch (err) {
    console.error('[bookingEmail] host voucher PDF generation failed:', err.message);
  }

  return send({ to: host.email, subject, html, text, attachments });
};

// Shared little reminder card (guest or host wording swapped by the caller).
const buildReminderHtml = ({
  heading, lead, itemName, itemImage, itemLocation, scheduleLine, extraRows = [],
}) => emailShell({
  preheader: lead.replace(/<[^>]+>/g, ''),
  eyebrow: heading,
  heading: escape(itemName),
  bodyHtml: `
    ${itemImage ? `<img src="${escape(itemImage)}" alt="" style="width:100%;max-height:180px;object-fit:cover;border-radius:10px;margin-bottom:16px;" />` : ''}
    <p style="color:#374151;line-height:1.6;margin:0 0 16px;">${lead}</p>
    ${kvTable([
      ['When', scheduleLine],
      itemLocation ? ['Location', escape(itemLocation)] : null,
      ...extraRows,
    ])}
  `,
});

const scheduleLineFor = (booking) => {
  const timeMatch = String(booking.specialRequests || '').match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  const time = timeMatch ? ` at ${timeMatch[1]}` : '';
  return `${fmtDate(booking.scheduledFor)}${time}`;
};

/**
 * "Starting soon" reminder to the GUEST — fired once per confirmed booking
 * (6h before) by the reminder sweep in reminder.service.js.
 */
const sendGuestReminder = async ({ booking, hoursBefore }) => {
  if (!booking?.guestEmail) return;
  const item = booking.itemSnapshot || {};
  const subject = `Reminder: ${item.name || 'your experience'} in ${hoursBefore} hours`;
  const html = buildReminderHtml({
    heading: `Starting in ${hoursBefore} hours`,
    lead: `Just a heads-up — <strong>${escape(item.name || 'your experience')}</strong> is coming up. Booking code <strong>${escape(booking.bookingCode)}</strong>.`,
    itemName: item.name || 'Your experience',
    itemImage: item.image,
    itemLocation: item.location,
    scheduleLine: scheduleLineFor(booking),
    extraRows: [['Guests', String(booking.guestCount || 1)]],
  });
  const text = `Reminder: ${item.name || 'your experience'} starts in ${hoursBefore} hours (${scheduleLineFor(booking)}). Booking ${booking.bookingCode}.`;
  return send({ to: booking.guestEmail, subject, html, text });
};

/**
 * Same reminder for the HOST — "your listing has a guest coming up".
 */
const sendHostReminder = async ({
  booking, exp, host, hoursBefore,
}) => {
  if (!host?.email) return;
  const subject = `Reminder: ${exp.name} in ${hoursBefore} hours — guest ${booking.guestName || 'Guest'}`;
  const html = buildReminderHtml({
    heading: `Booking in ${hoursBefore} hours`,
    lead: `<strong>${escape(exp.name)}</strong> has a guest coming up in ${hoursBefore} hours.`,
    itemName: exp.name,
    itemImage: exp.mainImage,
    itemLocation: exp.city || exp.location,
    scheduleLine: scheduleLineFor(booking),
    extraRows: [
      ['Guest', escape(booking.guestName || 'Guest')],
      ['Guests', String(booking.guestCount || 1)],
    ],
  });
  const text = `Reminder: ${exp.name} has a guest (${booking.guestName || 'Guest'}) in ${hoursBefore} hours (${scheduleLineFor(booking)}).`;
  return send({ to: host.email, subject, html, text });
};

module.exports = {
  sendBookingConfirmation, notifyHostOfBooking, buildVoucherHtml, sendGuestReminder, sendHostReminder,
};

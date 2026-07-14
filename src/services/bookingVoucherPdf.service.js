const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { fromPaise } = require('./booking.service');

/*
  Single-page booking voucher PDF — attached to the confirmation email and
  downloadable from the app's booking detail screen. Deliberately simple
  (one page, manual layout) rather than reusing contractPdf's multi-page
  flowing engine, since a voucher only ever needs one screen's worth of info.
*/

// pdf-lib's StandardFonts are WinAnsi-only — strip anything outside that so a
// guest name / item title with an unusual character never throws mid-render.
const sanitizeText = (raw) => {
  if (raw === null || raw === undefined) return '';
  const str = String(raw).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const ok = (code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d;
    out += ok ? ch : (code >= 0xa0 && code <= 0xff ? ch : '');
  }
  return out.replace(/[ \t]{2,}/g, ' ');
};

const PAGE_W = 595;
const PAGE_H = 842;
const ML = 48;
const MR = 48;
const CW = PAGE_W - ML - MR;

const BRAND = rgb(0.976, 0.725, 0.008);   // #F9B402
const INK = rgb(0.12, 0.14, 0.18);
const MUTE = rgb(0.42, 0.46, 0.53);
const LINE = rgb(0.88, 0.89, 0.92);
const ZEBRA = rgb(0.97, 0.97, 0.98);
const WHITE = rgb(1, 1, 1);

const fmtMoney = (paise, currency = 'INR') => {
  const v = fromPaise(paise || 0);
  const sym = currency === 'INR' ? 'Rs. ' : `${currency} `;
  return `${sym}${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};

const fmtDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const typeLabel = (t) => ({
  package: 'Retreat', room: 'Hotel Room', event: 'Event',
  addon: 'Add-on Activity', experience: 'Experience', event_activity: 'Activity',
})[t] || 'Booking';

/**
 * Build a single-page PDF voucher for a booking. `booking` is the raw
 * Sequelize row (or its .toJSON()) — reads the same paise/JSON columns the
 * rest of the booking code does.
 *
 * `opts.hostView` renders the HOST's copy instead of the guest's: the
 * pricing box shows only the base amount (subtotal — no GST/convenience fee/
 * discounts, which are platform-side, not the host's payout basis).
 */
const buildBookingVoucherPdf = async (bookingRow, opts = {}) => {
  const hostView = !!opts.hostView;
  const b = bookingRow.toJSON ? bookingRow.toJSON() : bookingRow;
  const item = b.itemSnapshot || {};
  const currency = b.currency || 'INR';

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const text = (s, x, y, opts2 = {}) => page.drawText(sanitizeText(s), { x, y, size: opts2.size || 10, font: opts2.bold ? bold : helv, color: opts2.color || INK });
  const line = (y) => page.drawLine({ start: { x: ML, y }, end: { x: PAGE_W - MR, y }, thickness: 1, color: LINE });

  // ── Header band ──────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: PAGE_H - 92, width: PAGE_W, height: 92, color: BRAND });
  text('reconnct', ML, PAGE_H - 42, { size: 24, bold: true, color: WHITE });
  text(hostView ? 'Host Booking Voucher' : 'Booking Voucher', ML, PAGE_H - 64, { size: 12, color: WHITE });
  text(String(b.bookingCode || ''), PAGE_W - MR - 180, PAGE_H - 42, { size: 16, bold: true, color: WHITE });
  text((b.status || '').toUpperCase(), PAGE_W - MR - 180, PAGE_H - 62, { size: 10, color: WHITE });

  let y = PAGE_H - 130;

  // ── Item ─────────────────────────────────────────────────────────────
  text(typeLabel(b.itemType).toUpperCase(), ML, y, { size: 9, bold: true, color: BRAND });
  y -= 18;
  text(item.name || 'Experience', ML, y, { size: 16, bold: true });
  y -= 18;
  if (item.city || item.location) {
    text(`Location: ${item.city || item.location}`, ML, y, { size: 10, color: MUTE });
    y -= 16;
  }
  y -= 6;
  line(y); y -= 22;

  // ── Trip details grid ────────────────────────────────────────────────
  const scheduleLine = b.scheduledEndAt
    ? `${fmtDate(b.scheduledFor)} - ${fmtDate(b.scheduledEndAt)}`
    : fmtDate(b.scheduledFor);
  const rows1 = [
    ['When', scheduleLine],
    ['Guests', String(b.guestCount || 1)],
    [b.itemType === 'room' ? 'Nights' : 'Duration', `${b.units || 1} ${b.itemType === 'room' ? 'night(s)' : 'day(s)'}`],
    ['Payment', b.paidAt ? 'Paid' : (b.status === 'cancelled' ? 'Cancelled' : 'Pending')],
  ];
  const colW = CW / 2;
  rows1.forEach(([k, v], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = ML + col * colW;
    const ry = y - row * 34;
    text(k.toUpperCase(), x, ry, { size: 8, color: MUTE });
    text(v, x, ry - 15, { size: 11, bold: true });
  });
  y -= Math.ceil(rows1.length / 2) * 34 + 10;
  line(y); y -= 24;

  // ── Lead traveller ───────────────────────────────────────────────────
  text(hostView ? 'GUEST' : 'LEAD TRAVELLER', ML, y, { size: 9, bold: true, color: MUTE }); y -= 18;
  text(`Name: ${b.guestName || '-'}`, ML, y, { size: 11 }); y -= 16;
  text(`Email: ${b.guestEmail || '-'}`, ML, y, { size: 11 }); y -= 16;
  text(`Phone: ${b.guestPhone || '-'}`, ML, y, { size: 11 }); y -= 12;
  if (b.specialRequests) {
    y -= 10;
    text(`Special requests: ${b.specialRequests}`, ML, y, { size: 10, color: MUTE });
    y -= 12;
  }
  y -= 10;
  line(y); y -= 24;

  if (hostView) {
    // Host copy: base amount only — GST/convenience fee/discounts are
    // platform-side, not part of the host's payout basis.
    text('AMOUNT', ML, y, { size: 9, bold: true, color: MUTE }); y -= 18;
    const boxH = 46;
    page.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH, color: ZEBRA });
    const baseLabel = `Base amount (${b.units || b.guestCount || 1} x ${fmtMoney(b.unitPricePaise, currency)})`;
    text(baseLabel, ML + 12, y - 18, { size: 10, color: MUTE });
    const baseStr = fmtMoney(b.subtotalPaise, currency);
    text(baseStr, PAGE_W - MR - 12 - bold.widthOfTextAtSize(sanitizeText(baseStr), 14), y - 30, { size: 14, bold: true, color: rgb(0.06, 0.46, 0.43) });
  } else {
    // ── Payment ────────────────────────────────────────────────────────
    text('PAYMENT', ML, y, { size: 9, bold: true, color: MUTE }); y -= 18;
    text(`Payment reference: ${b.paymentId || '-'}`, ML, y, { size: 10 }); y -= 15;
    text(`Method: ${b.paymentMethod || '-'}`, ML, y, { size: 10 }); y -= 15;
    text(`Paid at: ${b.paidAt ? fmtDate(b.paidAt) : '-'}`, ML, y, { size: 10 }); y -= 12;
    y -= 10;

    // Pricing box (zebra rows)
    const priceRows = [
      [`Subtotal (${b.units || b.guestCount || 1} x ${fmtMoney(b.unitPricePaise, currency)})`, fmtMoney(b.subtotalPaise, currency)],
      ['Taxes', fmtMoney(b.taxPaise, currency)],
    ];
    if (b.walletDiscountPaise > 0) priceRows.push(['Wallet credit', `- ${fmtMoney(b.walletDiscountPaise, currency)}`]);
    if (b.couponDiscountPaise > 0) priceRows.push([`Coupon ${b.couponCode || ''}`.trim(), `- ${fmtMoney(b.couponDiscountPaise, currency)}`]);

    const boxTop = y;
    const boxH = (priceRows.length + 1) * 22 + 16;
    page.drawRectangle({ x: ML, y: boxTop - boxH, width: CW, height: boxH, color: ZEBRA });
    let py = boxTop - 16;
    priceRows.forEach(([k, v]) => {
      text(k, ML + 12, py, { size: 10, color: MUTE });
      text(v, PAGE_W - MR - 12 - bold.widthOfTextAtSize(sanitizeText(v), 11), py, { size: 11 });
      py -= 22;
    });
    page.drawLine({ start: { x: ML + 12, y: py + 6 }, end: { x: PAGE_W - MR - 12, y: py + 6 }, thickness: 1, color: LINE });
    py -= 12;
    // Only say "Total paid" once money has actually moved — a pending/failed
    // booking's voucher must never claim it was paid.
    const totalLabel = b.paidAt ? 'Total paid' : (b.status === 'cancelled' || b.status === 'refunded') ? 'Total' : 'Total payable';
    text(totalLabel, ML + 12, py, { size: 12, bold: true });
    const totalStr = fmtMoney(b.totalPaise, currency);
    text(totalStr, PAGE_W - MR - 12 - bold.widthOfTextAtSize(sanitizeText(totalStr), 14), py, { size: 14, bold: true, color: rgb(0.06, 0.46, 0.43) });
  }

  // ── Footer ───────────────────────────────────────────────────────────
  text('Keep this voucher handy - show the booking code above at check-in.', ML, 50, { size: 9, color: MUTE });
  text('reconnct - Experiences that connect', ML, 36, { size: 9, color: MUTE });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
};

module.exports = { buildBookingVoucherPdf };

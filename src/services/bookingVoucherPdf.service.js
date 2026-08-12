const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { fromPaise } = require('./booking.service');

/*
  Single-page booking voucher PDF — a clean, premium contract-style layout with
  the reconnct logo, a hero image + gallery, the experience details, full
  payment info and a clear price breakdown. Attached to the confirmation email
  and downloadable from the admin / owner panels.
*/

const sanitizeText = (raw) => {
  if (raw === null || raw === undefined) return '';
  const str = String(raw).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const ok = (code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0xa0 && code <= 0xff);
    out += ok ? ch : '';
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
};

const PAGE_W = 595;
const PAGE_H = 842;
const ML = 40;
const MR = 40;
const CW = PAGE_W - ML - MR;

const BRAND = rgb(0.976, 0.706, 0.008); // #F9B402
const BRAND_DK = rgb(0.70, 0.45, 0.03);
const INK = rgb(0.10, 0.12, 0.16);
const MUTE = rgb(0.45, 0.49, 0.56);
const FAINT = rgb(0.62, 0.66, 0.72);
const LINE = rgb(0.89, 0.90, 0.93);
const SOFT = rgb(0.965, 0.968, 0.975);
const WHITE = rgb(1, 1, 1);
const GREEN = rgb(0.06, 0.46, 0.43);
const NAVY = rgb(0.09, 0.13, 0.22);

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
const fmtDateTime = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
};
const typeLabel = (t) => ({
  package: 'Retreat', room: 'Hotel Room', event: 'Event', addon: 'Add-on Activity', experience: 'Experience', event_activity: 'Activity',
})[t] || 'Booking';

// pdf-lib supports only PNG/JPG. Fetch + embed; skip webp / failures silently.
const embedImage = async (pdf, url) => {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x89 && buf[1] === 0x50) return await pdf.embedPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return await pdf.embedJpg(buf);
    return null;
  } catch { return null; }
};
const embedLogo = async (pdf) => {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '../assets/reconnct-logo-white.png'));
    return await pdf.embedPng(buf);
  } catch { return null; }
};

const wrapLines = (str, font, size, maxW) => {
  const words = sanitizeText(str).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
};

// Cover-fit an image inside a box (centered, cropped by clipping via a masking
// rectangle is unavailable in pdf-lib, so we contain + fill the gaps with a
// light background so it always looks tidy).
const drawImageBox = (page, img, x, yTop, w, h) => {
  page.drawRectangle({ x, y: yTop - h, width: w, height: h, color: SOFT });
  if (!img) return;
  const scale = Math.max(w / img.width, h / img.height); // cover
  const dw = img.width * scale; const dh = img.height * scale;
  const dx = x + (w - dw) / 2; const dy = yTop - h + (h - dh) / 2;
  // Clip by drawing only within the box: pdf-lib can't clip, so cover-scale can
  // overflow slightly. Cap by switching to contain when overflow is large.
  if (dw > w * 1.6 || dh > h * 1.6) {
    const s2 = Math.min(w / img.width, h / img.height);
    const cw = img.width * s2; const ch = img.height * s2;
    page.drawImage(img, { x: x + (w - cw) / 2, y: yTop - h + (h - ch) / 2, width: cw, height: ch });
  } else {
    page.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
  }
};

const buildBookingVoucherPdf = async (bookingRow, opts = {}) => {
  const hostView = !!opts.hostView;
  const extras = opts.extras || {};
  const b = bookingRow.toJSON ? bookingRow.toJSON() : bookingRow;
  const item = b.itemSnapshot || {};
  const currency = b.currency || 'INR';

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await embedLogo(pdf);

  const text = (s, x, y, o = {}) => page.drawText(sanitizeText(s), { x, y, size: o.size || 10, font: o.bold ? bold : helv, color: o.color || INK });
  const rtext = (s, xRight, y, o = {}) => { const w = (o.bold ? bold : helv).widthOfTextAtSize(sanitizeText(s), o.size || 10); text(s, xRight - w, y, o); };
  const hline = (y, x1 = ML, x2 = PAGE_W - MR, c = LINE) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 1, color: c });

  // ── Header band ──────────────────────────────────────────────────────────
  const HB = 84;
  page.drawRectangle({ x: 0, y: PAGE_H - HB, width: PAGE_W, height: HB, color: BRAND });
  if (logo) {
    const lw = 130; const lh = (logo.height * lw) / logo.width;
    page.drawImage(logo, { x: ML, y: PAGE_H - 34 - lh / 2, width: lw, height: lh });
  } else {
    text('reconnct', ML, PAGE_H - 40, { size: 22, bold: true, color: WHITE });
  }
  text(hostView ? 'Host Booking Voucher' : 'Booking Voucher', ML, PAGE_H - 62, { size: 10, color: rgb(1, 1, 1) });
  rtext(String(b.bookingCode || ''), PAGE_W - MR, PAGE_H - 36, { size: 15, bold: true, color: WHITE });
  rtext((b.status || '').toUpperCase(), PAGE_W - MR, PAGE_H - 56, { size: 9, bold: true, color: rgb(1, 1, 1) });

  let y = PAGE_H - HB - 16;

  // ── Hero image + gallery (2-col) ─────────────────────────────────────────
  const mainUrl = extras.image || item.image;
  const galleryUrls = (Array.isArray(extras.gallery) ? extras.gallery : []).filter((g) => g && g !== mainUrl).slice(0, 4);
  const mainImg = await embedImage(pdf, mainUrl);
  const galleryImgs = [];
  for (const g of galleryUrls) { galleryImgs.push(await embedImage(pdf, g)); } // eslint-disable-line no-await-in-loop

  if (mainImg || galleryImgs.some(Boolean)) {
    const IMG_H = 148;
    if (galleryImgs.some(Boolean)) {
      const mainW = Math.round(CW * 0.58);
      drawImageBox(page, mainImg, ML, y, mainW, IMG_H);
      const gx = ML + mainW + 8;
      const gw = (PAGE_W - MR - gx - 8) / 2;
      const gh = (IMG_H - 8) / 2;
      galleryImgs.slice(0, 4).forEach((g, i) => {
        const col = i % 2; const row = Math.floor(i / 2);
        drawImageBox(page, g, gx + col * (gw + 8), y - row * (gh + 8), gw, gh);
      });
    } else {
      drawImageBox(page, mainImg, ML, y, CW, IMG_H);
    }
    y -= IMG_H + 18;
  } else {
    y -= 4;
  }

  // ── Experience card ──────────────────────────────────────────────────────
  const aboutLines = extras.about ? wrapLines(extras.about, helv, 9.5, CW - 28).slice(0, 3) : [];
  const cardH = 30 + 16 + (item.city || item.location ? 14 : 0) + (aboutLines.length ? aboutLines.length * 12 + 8 : 0) + 14;
  page.drawRectangle({ x: ML, y: y - cardH, width: CW, height: cardH, color: SOFT });
  page.drawRectangle({ x: ML, y: y - cardH, width: 3, height: cardH, color: BRAND });
  let cy = y - 18;
  text(typeLabel(b.itemType).toUpperCase(), ML + 14, cy, { size: 8, bold: true, color: BRAND_DK }); cy -= 16;
  text(item.name || 'Experience', ML + 14, cy, { size: 15, bold: true }); cy -= 15;
  if (item.city || item.location) { text(`Location:  ${item.city || item.location || ''}`, ML + 14, cy, { size: 9.5, color: MUTE }); cy -= 13; }
  if (aboutLines.length) { cy -= 3; for (const ln of aboutLines) { text(ln, ML + 14, cy, { size: 9.5, color: rgb(0.30, 0.34, 0.40) }); cy -= 12; } }
  y -= cardH + 16;

  // ── Detail cells (When / Slot / Guests / Duration / Payment) ─────────────
  const slotMatch = String(b.specialRequests || '').match(/Preferred time:\s*(.+)/i);
  const slot = slotMatch ? slotMatch[1].trim() : (b.scheduledAt ? new Date(b.scheduledAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-');
  const cells = [
    ['WHEN', b.scheduledEndAt ? `${fmtDate(b.scheduledFor)} - ${fmtDate(b.scheduledEndAt)}` : fmtDate(b.scheduledFor)],
    ['TIME SLOT', slot],
    ['GUESTS', String(b.guestCount || 1)],
    ['DURATION', extras.durationLabel || `${b.units || 1} ${b.itemType === 'room' ? 'night(s)' : 'day(s)'}`],
    ['PAYMENT', b.paidAt ? 'Paid' : (b.status === 'cancelled' ? 'Cancelled' : 'Pending')],
  ];
  const cellW = CW / cells.length;
  cells.forEach(([k, v], i) => {
    const x = ML + i * cellW;
    if (i > 0) page.drawLine({ start: { x, y: y - 2 }, end: { x, y: y - 32 }, thickness: 1, color: LINE });
    text(k, x + (i > 0 ? 10 : 0), y - 10, { size: 7.5, bold: true, color: FAINT });
    const vLines = wrapLines(String(v), bold, 10.5, cellW - 12);
    text(vLines[0] || '-', x + (i > 0 ? 10 : 0), y - 26, { size: 10.5, bold: true });
  });
  y -= 44; hline(y); y -= 20;

  // ── Lead traveller + Payment (2-col) ─────────────────────────────────────
  const colW = (CW - 24) / 2;
  const rx = ML + colW + 24;
  const startY = y;
  // Left: traveller
  text(hostView ? 'GUEST' : 'LEAD TRAVELLER', ML, y, { size: 8, bold: true, color: FAINT }); y -= 16;
  text(`Name: ${b.guestName || '-'}`, ML, y, { size: 10 }); y -= 14;
  text(`Email: ${b.guestEmail || '-'}`, ML, y, { size: 10 }); y -= 14;
  text(`Phone: ${b.guestPhone || '-'}`, ML, y, { size: 10 }); y -= 14;
  if (b.specialRequests) { const sr = wrapLines(`Note: ${b.specialRequests}`, helv, 9, colW); sr.slice(0, 2).forEach((ln) => { text(ln, ML, y, { size: 9, color: MUTE }); y -= 12; }); }
  const leftEnd = y;
  // Right: payment
  let py = startY;
  text('PAYMENT DETAILS', rx, py, { size: 8, bold: true, color: FAINT }); py -= 16;
  const payRows = [
    ['Order ID', b.paymentOrderId],
    ['Payment ID', b.paymentId],
    ['Method', b.paymentMethod],
    ['Currency', currency],
    ['Paid at', b.paidAt ? fmtDateTime(b.paidAt) : '-'],
    ['Booked at', fmtDateTime(b.createdAt)],
  ];
  payRows.forEach(([k, v]) => {
    text(k, rx, py, { size: 9, color: MUTE });
    const vLines = wrapLines(String(v || '-'), helv, 9, colW - 70);
    text(vLines[0] || '-', rx + 70, py, { size: 9, bold: true });
     py -= 14;
  });
  y = Math.min(leftEnd, py) - 8;
  hline(y); y -= 20;

  // ── Price breakdown ──────────────────────────────────────────────────────
  text('PRICE BREAKDOWN', ML, y, { size: 8, bold: true, color: FAINT }); y -= 16;
  const priceRows = [];
  if (hostView) {
    priceRows.push([`Base amount (${b.units || b.guestCount || 1} x ${fmtMoney(b.unitPricePaise, currency)})`, fmtMoney(b.subtotalPaise, currency)]);
  } else {
    priceRows.push([`Subtotal (${b.units || b.guestCount || 1} x ${fmtMoney(b.unitPricePaise, currency)})`, fmtMoney(b.subtotalPaise, currency)]);
    if (b.taxPaise > 0) priceRows.push([`Taxes${b.gstPaise ? ' (GST)' : ''}`, fmtMoney(b.taxPaise, currency)]);
    if (b.walletDiscountPaise > 0) priceRows.push(['Wallet credit', `- ${fmtMoney(b.walletDiscountPaise, currency)}`]);
    if (b.couponDiscountPaise > 0) priceRows.push([`Coupon ${b.couponCode || ''}`.trim(), `- ${fmtMoney(b.couponDiscountPaise, currency)}`]);
  }
  const totalPaise = hostView ? b.subtotalPaise : b.totalPaise;
  const boxH = priceRows.length * 22 + 46;
  const boxTop = y;
  page.drawRectangle({ x: ML, y: boxTop - boxH, width: CW, height: boxH, color: SOFT });
  let qy = boxTop - 20;
  priceRows.forEach(([k, v]) => {
    text(k, ML + 14, qy, { size: 10, color: MUTE });
    rtext(v, PAGE_W - MR - 14, qy, { size: 10.5 });
    qy -= 22;
  });
  hline(qy + 8, ML + 14, PAGE_W - MR - 14);
  qy -= 6;
  const totalLabel = hostView ? 'Payout basis (B2B)' : (b.paidAt ? 'Total paid' : (b.status === 'cancelled' || b.status === 'refunded' ? 'Total' : 'Total payable'));
  text(totalLabel, ML + 14, qy, { size: 12, bold: true });
  rtext(fmtMoney(totalPaise, currency), PAGE_W - MR - 14, qy - 2, { size: 15, bold: true, color: GREEN });
  y = boxTop - boxH - 16;

  // ── Footer CTA band ──────────────────────────────────────────────────────
  const FB = 58;
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: FB, color: NAVY });
  if (logo) {
    const lw = 96; const lh = (logo.height * lw) / logo.width;
    page.drawImage(logo, { x: ML, y: FB / 2 - lh / 2, width: lw, height: lh });
  } else {
    text('reconnct', ML, FB / 2 - 4, { size: 14, bold: true, color: WHITE });
  }
  rtext('Experiences that connect', PAGE_W - MR, FB / 2 + 4, { size: 10, bold: true, color: BRAND });
  rtext('Show this booking code at check-in - keep this voucher handy.', PAGE_W - MR, FB / 2 - 10, { size: 8, color: rgb(0.75, 0.78, 0.84) });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
};

module.exports = { buildBookingVoucherPdf };

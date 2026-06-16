const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/*
  Multi-page WHOLESALE AGREEMENT generator (Traveon Ventures LLP = Operator).
  Modelled on a real hotel wholesale contract: parties, recitals, room types,
  rates, policies, billing and signatures. Everything is filled from the
  onboarded property; anything the property doesn't capture falls back to a
  sensible standard clause so the document always reads as a complete contract.

  Kept model-free: the caller passes plain objects so it can run inside or
  outside a request.
*/

// ── font-safety: pdf-lib StandardFonts are WinAnsi only ────────────────────
const WIN1252_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);
const sanitizeText = (raw) => {
  if (raw === null || raw === undefined) return '';
  const str = String(raw).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let out = '';
  let dropped = false;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const ok = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)
      || code === 0x09 || code === 0x0a || code === 0x0d || WIN1252_EXTRA.has(code);
    if (ok) { out += ch; dropped = false; }
    else if (!dropped) { out += ''; dropped = true; }
  }
  return out.replace(/[ \t]{2,}/g, ' ');
};

const DEFAULT_OPERATOR = {
  company: 'Traveon Ventures LLP',
  city: 'New Delhi, India',
  signatory: 'Abhineet Gupta',
  title: 'Founder Director',
  phone: '+91 95401 11307',
  email: 'abhineet@traveon.in',
};

const PAGE_W = 595;
const PAGE_H = 842;
const ML = 42;   // left margin
const MR = 42;   // right margin
const CW = PAGE_W - ML - MR; // content width
const TOP = 762; // first content y (below header band)
const BOTTOM = 64;

const TEAL = rgb(0.06, 0.46, 0.43);
const INK = rgb(0.16, 0.18, 0.22);
const SLATE = rgb(0.30, 0.33, 0.39);
const MUTE = rgb(0.50, 0.53, 0.58);
const HEADBG = rgb(0.82, 0.86, 0.92);
const LINEC = rgb(0.78, 0.80, 0.84);
const ZEBRA = rgb(0.96, 0.97, 0.98);

// ── A small flowing-document engine over pdf-lib ───────────────────────────
class Doc {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.f = fonts.helv;
    this.b = fonts.bold;
    this.fi = fonts.ital;
    this.page = null;
    this.y = 0;
    this.pageNo = 0;
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pageNo += 1;
    // header band
    this.page.drawRectangle({ x: 0, y: PAGE_H - 54, width: PAGE_W, height: 54, color: TEAL });
    this.page.drawText('Retreats by Traveon', { x: ML, y: PAGE_H - 30, font: this.b, size: 16, color: rgb(1, 1, 1) });
    this.page.drawText('Wholesale Accommodation Agreement', { x: ML, y: PAGE_H - 46, font: this.f, size: 10, color: rgb(1, 1, 1) });
    // footer
    this.page.drawLine({ start: { x: ML, y: 50 }, end: { x: PAGE_W - MR, y: 50 }, thickness: 0.5, color: LINEC });
    this.page.drawText('Traveon Ventures LLP, New Delhi, India  |  abhineet@traveon.in  |  +91 95401 11307', { x: ML, y: 38, font: this.f, size: 7.5, color: MUTE });
    this.y = TOP;
  }

  ensure(h) { if (this.y - h < BOTTOM) this.newPage(); }
  gap(n = 10) { this.y -= n; }

  // wrap + draw a paragraph; returns nothing, advances y
  para(text, { font = this.f, size = 10, color = SLATE, lh = 14.5, x = ML, width = CW, gap = 8 } = {}) {
    const words = sanitizeText(text).split(/\s+/).filter(Boolean);
    let line = '';
    const flush = () => {
      this.ensure(lh);
      if (this.y === TOP && this.pageNo > 1) { /* fresh page top */ }
      this.page.drawText(line, { x, y: this.y, font, size, color });
      this.y -= lh;
    };
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) > width && line) { flush(); line = w; }
      else line = trial;
    }
    if (line) flush();
    this.y -= gap;
  }

  bullet(text, opts = {}) {
    this.ensure(14);
    this.page.drawText('•', { x: ML + 2, y: this.y, font: this.b, size: 10, color: TEAL });
    this.para(text, { ...opts, x: ML + 16, width: CW - 16, gap: opts.gap ?? 3 });
  }

  // simple key/value row
  kv(label, value) {
    this.ensure(15);
    this.page.drawText(sanitizeText(label), { x: ML, y: this.y, font: this.b, size: 10, color: INK });
    this.page.drawText(sanitizeText(value || '-'), { x: ML + 150, y: this.y, font: this.f, size: 10, color: SLATE });
    this.y -= 16;
  }

  heading(text) {
    this.gap(6);
    this.ensure(22);
    this.page.drawText(sanitizeText(text), { x: ML, y: this.y, font: this.b, size: 12.5, color: TEAL });
    this.y -= 8;
    this.page.drawLine({ start: { x: ML, y: this.y }, end: { x: PAGE_W - MR, y: this.y }, thickness: 0.7, color: LINEC });
    this.y -= 12;
  }

  title(text) {
    this.ensure(30);
    const w = this.b.widthOfTextAtSize(text, 17);
    this.page.drawText(sanitizeText(text), { x: (PAGE_W - w) / 2, y: this.y, font: this.b, size: 17, color: INK });
    this.y -= 8;
    this.page.drawLine({ start: { x: (PAGE_W - 120) / 2, y: this.y }, end: { x: (PAGE_W + 120) / 2, y: this.y }, thickness: 1.4, color: TEAL });
    this.y -= 22;
  }

  // table: cols = [{ title, width, align }], rows = [[c1,c2,...]]
  table(cols, rows) {
    const rowH = 20;
    const drawHeader = () => {
      this.ensure(rowH + 4);
      let x = ML;
      this.page.drawRectangle({ x: ML, y: this.y - rowH + 5, width: CW, height: rowH, color: HEADBG });
      for (const c of cols) {
        this.page.drawText(sanitizeText(c.title), { x: x + 5, y: this.y - 9, font: this.b, size: 8.5, color: INK });
        x += c.width;
      }
      // vertical lines
      this._tableBorders(rowH, true);
      this.y -= rowH;
    };
    drawHeader();
    rows.forEach((row, ri) => {
      // measure tallest cell (wrap)
      const lines = cols.map((c, ci) => this._wrapCell(String(row[ci] ?? ''), c.width - 10, 8.5));
      const h = Math.max(rowH, Math.max(...lines.map((l) => l.length)) * 11 + 8);
      if (this.y - h < BOTTOM) { this.newPage(); drawHeader(); }
      if (ri % 2 === 1) this.page.drawRectangle({ x: ML, y: this.y - h + 5, width: CW, height: h, color: ZEBRA });
      let x = ML;
      cols.forEach((c, ci) => {
        lines[ci].forEach((ln, li) => {
          const tw = this.f.widthOfTextAtSize(ln, 8.5);
          const tx = c.align === 'center' ? x + (c.width - tw) / 2 : x + 5;
          this.page.drawText(ln, { x: tx, y: this.y - 9 - li * 11, font: this.f, size: 8.5, color: SLATE });
        });
        x += c.width;
      });
      this._tableBorders(h, false);
      this.y -= h;
    });
    this.y -= 10;
  }

  _wrapCell(text, maxW, size) {
    const words = sanitizeText(text).split(/\s+/).filter(Boolean);
    const out = []; let line = '';
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (this.f.widthOfTextAtSize(trial, size) > maxW && line) { out.push(line); line = w; }
      else line = trial;
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  }

  _tableBorders(h, isHeader) {
    const top = this.y + 5;
    const bot = this.y - h + 5;
    let x = ML;
    const cols = this._cols || [];
    // outer + verticals handled by caller via _cols set in table()
    this.page.drawLine({ start: { x: ML, y: bot }, end: { x: PAGE_W - MR, y: bot }, thickness: 0.5, color: LINEC });
    if (isHeader) this.page.drawLine({ start: { x: ML, y: top }, end: { x: PAGE_W - MR, y: top }, thickness: 0.5, color: LINEC });
    for (const c of cols) { this.page.drawLine({ start: { x, y: top }, end: { x, y: bot }, thickness: 0.5, color: LINEC }); x += c.width; }
    this.page.drawLine({ start: { x: PAGE_W - MR, y: top }, end: { x: PAGE_W - MR, y: bot }, thickness: 0.5, color: LINEC });
  }
}

// helper: fit columns to content width
const fitCols = (cols) => {
  const total = cols.reduce((s, c) => s + c.w, 0);
  return cols.map((c) => ({ title: c.t, width: Math.round((c.w / total) * CW), align: c.a }));
};

const money = (n, cur = 'INR') => (Number(n) > 0 ? `${cur} ${Number(n).toLocaleString()}` : '-');

const generateContractPdf = async ({ property = {}, rooms = [], categories = [], operator = DEFAULT_OPERATOR }) => {
  const pdf = await PDFDocument.create();
  const fonts = {
    helv: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    ital: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const d = new Doc(pdf, fonts);
  const cur = property.currency || 'INR';
  const year = new Date().getFullYear();

  // count rooms per category from `categories` or by grouping rooms
  const catCount = {};
  categories.forEach((c) => { if (c?.name) catCount[c.name] = Number(c.count) || 0; });
  rooms.forEach((r) => { if (!catCount[r.category]) catCount[r.category] = (catCount[r.category] || 0) + 1; });

  // ── Title + parties ──────────────────────────────────────────────────────
  d.title(`WHOLESALE AGREEMENT ${year}`);

  d.gap(2);
  d.page.drawText('Between:', { x: ML, y: d.y, font: d.b, size: 10.5, color: INK });
  d.para(property.name || 'The Property', { x: ML + 110, width: CW - 110, font: d.b, size: 10.5, color: INK, gap: 2 });
  d.para(property.address || '-', { x: ML + 110, width: CW - 110, gap: 2 });
  d.para('(Hereinafter referred to as the "Hotel")', { x: ML + 110, width: CW - 110, font: d.fi, color: MUTE, gap: 10 });

  d.page.drawText('And:', { x: ML, y: d.y, font: d.b, size: 10.5, color: INK });
  d.para(operator.company, { x: ML + 110, width: CW - 110, font: d.b, size: 10.5, color: INK, gap: 2 });
  d.para(operator.city, { x: ML + 110, width: CW - 110, gap: 2 });
  d.para('(Hereinafter referred to as the "Operator")', { x: ML + 110, width: CW - 110, font: d.fi, color: MUTE, gap: 10 });

  d.page.drawText('For the period:', { x: ML, y: d.y, font: d.b, size: 10.5, color: INK });
  d.para(`Year ${year}`, { x: ML + 110, width: CW - 110, font: d.b, color: INK, gap: 14 });

  // ── Recitals ───────────────────────────────────────────────────────────
  d.para('WHEREAS', { font: d.b, color: INK, gap: 4 });
  d.para('The "Operator" will promote the "Hotel" by independently featuring the "Hotel" in its respective marketing channels during the contracted period.', { gap: 8 });
  d.para('AND', { font: d.b, color: INK, gap: 4 });
  d.para('The "Hotel" will provide accommodation at the room rates and conditions outlined below, which will remain applicable for the contracted period mentioned above.', { gap: 10 });

  const desc = [
    property.name ? `${property.name} is located at ${property.locationText || property.address || 'the address stated above'}.` : '',
    property.numberOfRooms ? `The property offers ${property.numberOfRooms} rooms across ${Object.keys(catCount).length || rooms.length} categories, well-equipped and furnished for a comfortable wellness stay.` : 'The property offers comfortable, well-furnished rooms for a wellness stay.',
  ].filter(Boolean).join(' ');
  if (desc) d.para(desc, { gap: 10 });

  // ── Room Types ───────────────────────────────────────────────────────────
  if (rooms.length || Object.keys(catCount).length) {
    d.heading('Room Types');
    const seen = new Set();
    const typeRows = [];
    rooms.forEach((r) => {
      if (seen.has(r.category)) return;
      seen.add(r.category);
      typeRows.push([
        r.category || 'Room',
        String(catCount[r.category] || 1),
        r.sizeSqft ? `${r.sizeSqft} sqft` : '-',
        r.bedType || '-',
        r.washroomType || '-',
      ]);
    });
    d._cols = fitCols([{ t: 'Room Type', w: 30, a: 'left' }, { t: 'No. of Rooms', w: 16, a: 'center' }, { t: 'Size', w: 14, a: 'center' }, { t: 'Bed Type', w: 22, a: 'center' }, { t: 'Washroom', w: 18, a: 'center' }]);
    d.table(d._cols, typeRows);
  }

  // ── A. Room Rates ─────────────────────────────────────────────────────────
  d.heading('A. Room Rates');
  const rateCols = fitCols([{ t: 'Room Type', w: 34, a: 'left' }, { t: 'Occupancy', w: 22, a: 'center' }, { t: `Rate / night (${cur})`, w: 24, a: 'center' }, { t: 'Original', w: 20, a: 'center' }]);
  d._cols = rateCols;
  const rateRows = rooms.map((r) => [
    r.category || 'Room',
    occLabel(r),
    money(r.price, cur),
    money(r.priceOriginal, cur),
  ]);
  d.table(rateCols, rateRows.length ? rateRows : [['—', '—', '—', '—']]);
  d.bullet(property.gstNote || 'All rates are quoted per room per night and are subject to applicable taxes (GST) and service charges as displayed at the time of booking.');
  d.bullet('Rates are nett, non-commissionable and confidential to the Operator.');
  d.gap(6);

  // ── B. Children & Extra Person Policy ─────────────────────────────────────
  d.heading('B. Children & Extra Person Policy');
  const tiers = collectTiers(rooms);
  if (tiers.length) {
    const tierCols = fitCols([{ t: 'Age band', w: 30, a: 'left' }, { t: 'Bed', w: 24, a: 'center' }, { t: `Charge (${cur})`, w: 26, a: 'center' }]);
    d._cols = tierCols;
    d.table(tierCols, tiers.map((t) => [t.band, t.bed, t.charge]));
  }
  d.bullet('Children below 12 years may stay free in the parents\' room subject to the maximum occupancy of the room category, using existing bedding.');
  d.bullet('An additional charge for an extra rollaway bed applies for a third adult sharing the same room, as per the rates above.');
  d.gap(6);

  // ── C. Room Capacity ──────────────────────────────────────────────────────
  if (rooms.length) {
    d.heading('C. Room Capacity');
    const capCols = fitCols([{ t: 'Room Type', w: 34, a: 'left' }, { t: 'Size', w: 18, a: 'center' }, { t: 'Bed Type', w: 26, a: 'center' }, { t: 'Max Occupancy', w: 22, a: 'center' }]);
    d._cols = capCols;
    const seen = new Set();
    const capRows = [];
    rooms.forEach((r) => { if (seen.has(r.category)) return; seen.add(r.category); capRows.push([r.category || 'Room', r.sizeSqft ? `${r.sizeSqft} sqft` : '-', r.bedType || '-', occLabel(r)]); });
    d.table(capCols, capRows);
  }

  // ── Standard clauses ──────────────────────────────────────────────────────
  d.heading('D. Check-in / Check-out');
  d.para('Standard check-in time is 14:00 hrs; early check-in is subject to availability. Check-out time is 12:00 noon. Late check-out until 18:00 hrs is charged at 50% of the applicable room rate; departure after 18:00 hrs at 100% of the applicable room rate, subject to availability.');

  d.heading('E. Cancellation / No-Show Policy');
  d.para('Reservations cancelled within 24 hours of the scheduled arrival, or in the event of a guest "no-show", will be charged one night\'s room revenue as a cancellation / no-show fee, unless a longer policy is stated for a specific booking or peak period.');

  d.heading('F. Early Departure Policy');
  d.para('Regardless of an early departure, all originally booked room nights (whether or not consumed) and applicable taxes will be billed to the Operator.');

  d.heading('G. Taxation Clause');
  d.para('All rates are exclusive of statutory taxes unless stated otherwise. If the Government imposes any sales-related taxes, the same shall be added to the invoice for the supply of services.');

  d.heading('H. Reservation Procedures');
  d.para('All reservations must be made in writing, indicating the guest name(s), arrival/departure details and the type of accommodation required. Rooms are subject to availability. Stop-sale notifications will be issued by the Hotel as applicable, and reservations must be confirmed within 24 hours of any availability-change notification.');

  d.heading('I. Vouchers');
  d.para('A voucher must be sent to the Hotel prior to the arrival of the guest. A copy of the voucher specimen must be shared in advance for identification purposes.');

  d.heading('J. Billing');
  d.para('Invoices are raised periodically and are payable in full within fifteen (15) days of invoicing. No charges may be deducted or withheld for any reason. Any disputed charge must be raised with supporting documents, and adjustments (if any) will be reflected in a subsequent invoice. Persistent non-payment may result in termination of this Agreement at the Hotel\'s option.');

  d.heading('K. Commission');
  d.para('All rates quoted in this Agreement are nett and non-commissionable.');

  d.heading('L. Selling');
  d.para('The Operator undertakes (a) not to sell, assign or disclose the rates quoted herein to any third party, whether directly or indirectly (including via print, internet or other web channels), and (b) not to utilise any room/meal allocation other than for packaged booking(s).');

  d.heading('M. Jurisdiction');
  d.para('This Agreement shall be construed and governed by the laws of India, and any dispute shall be subject to the jurisdiction of the courts at the Operator\'s registered office.');

  d.heading('N. Force Majeure');
  d.para('The performance of this Agreement by either party is subject to acts of God, government authority, disaster, strikes, civil disorder or other emergencies which make it impossible to provide the facilities/services. The Agreement may be terminated for such reasons by written notice from one party to the other without liability.');

  d.heading('O. Confidentiality');
  d.para('All information contained in this Agreement is private and confidential and may not be disclosed to third parties for any reason. If the contracted rates are offered or made available to any party without the Hotel\'s prior written consent, this Agreement will terminate automatically without prejudice to either party\'s rights.');

  // ── Signatures ────────────────────────────────────────────────────────────
  d.gap(18);
  d.ensure(120);
  const colX2 = ML + CW / 2 + 10;
  const sigY = d.y;
  d.page.drawText('For and on behalf of', { x: ML, y: sigY, font: d.f, size: 9, color: MUTE });
  d.page.drawText('For and on behalf of', { x: colX2, y: sigY, font: d.f, size: 9, color: MUTE });
  d.page.drawText(sanitizeText(property.name || 'The Hotel'), { x: ML, y: sigY - 14, font: d.b, size: 10.5, color: INK });
  d.page.drawText(sanitizeText(operator.company), { x: colX2, y: sigY - 14, font: d.b, size: 10.5, color: INK });

  const lineY = sigY - 70;
  d.page.drawLine({ start: { x: ML, y: lineY }, end: { x: ML + 200, y: lineY }, thickness: 1, color: SLATE });
  d.page.drawLine({ start: { x: colX2, y: lineY }, end: { x: colX2 + 200, y: lineY }, thickness: 1, color: SLATE });

  d.page.drawText(sanitizeText(property.ownerName || 'Authorised Signatory'), { x: ML, y: lineY - 14, font: d.b, size: 9.5, color: INK });
  d.page.drawText('Authorised Signatory, Hotel', { x: ML, y: lineY - 26, font: d.f, size: 8.5, color: MUTE });
  if (property.ownerPhone) d.page.drawText(sanitizeText(property.ownerPhone), { x: ML, y: lineY - 38, font: d.f, size: 8.5, color: MUTE });
  if (property.ownerEmail) d.page.drawText(sanitizeText(property.ownerEmail), { x: ML, y: lineY - 50, font: d.f, size: 8.5, color: MUTE });

  d.page.drawText(sanitizeText(operator.signatory), { x: colX2, y: lineY - 14, font: d.b, size: 9.5, color: INK });
  d.page.drawText(sanitizeText(operator.title), { x: colX2, y: lineY - 26, font: d.f, size: 8.5, color: MUTE });
  d.page.drawText(sanitizeText(operator.phone), { x: colX2, y: lineY - 38, font: d.f, size: 8.5, color: MUTE });
  d.page.drawText(sanitizeText(operator.email), { x: colX2, y: lineY - 50, font: d.f, size: 8.5, color: MUTE });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
};

// max-occupancy label from bed type / explicit value
const occLabel = (r) => {
  if (r.maxOccupancy) return `${r.maxOccupancy} guest${r.maxOccupancy > 1 ? 's' : ''}`;
  const t = String(r.bedType || '').toLowerCase();
  if (t.includes('triple')) return '3 guests';
  if (t.includes('quad') || t.includes('family')) return '4 guests';
  if (t.includes('single')) return '1 guest';
  return '2 guests';
};

// collapse all rooms' extra-person tiers into a unique policy table
const collectTiers = (rooms) => {
  const map = new Map();
  rooms.forEach((r) => (Array.isArray(r.extraPersonTiers) ? r.extraPersonTiers : []).forEach((t) => {
    const band = `${t.ageFrom}${t.ageTo != null ? `-${t.ageTo}` : '+'} yrs`;
    const bed = t.bed === 'with' ? 'With bed' : 'Without bed';
    const charge = t.priceType === 'custom' ? `${Number(t.price || 0).toLocaleString()}` : 'Complimentary';
    map.set(`${band}|${bed}|${charge}`, { band, bed, charge });
  }));
  return [...map.values()];
};

module.exports = { generateContractPdf, DEFAULT_OPERATOR };

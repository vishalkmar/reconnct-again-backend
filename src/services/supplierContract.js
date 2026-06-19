const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/*
  Supplier B2B service-contract generators — PDF (pdf-lib) and Word (.doc via
  Word-compatible HTML). Both render the same data:
    {
      title, operator, supplier, intro, formalities,
      items: [{ name, b2bPrice, dates:[{date, slots:[{start,end}]}] }]
    }
  `items` should already be filtered to the rows the admin chose to include.
*/

const money = (n) => `INR ${Number(n || 0).toLocaleString('en-IN')}`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const today = () => new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

const fmtDate = (d) => {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d || '') : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
// "12 Jun 2026: 09:00-10:00, 10:00-11:00"  (one string per date)
const scheduleLines = (dates) => (Array.isArray(dates) ? dates : []).map((d) => {
  const slots = (Array.isArray(d.slots) ? d.slots : []).map((s) => `${s.start}-${s.end}`).join(', ');
  return `${fmtDate(d.date)}${slots ? `: ${slots}` : ''}`;
});

// strip basic HTML so rich-text intros render as plain paragraphs in the PDF
const toPlain = (s) => String(s || '')
  .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .split(/\n+/).map((l) => l.trim()).filter(Boolean);

// ── font-safety: pdf-lib StandardFonts are WinAnsi only ────────────────────
const sanitize = (raw) => String(raw ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split('').filter((ch) => { const c = ch.codePointAt(0); return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff); }).join('');

const PAGE_W = 595;
const PAGE_H = 842;
const ML = 48;
const CW = PAGE_W - ML * 2;
const TEAL = rgb(0.043, 0.463, 0.427);
const TEAL_SOFT = rgb(0.90, 0.95, 0.94);
const INK = rgb(0.14, 0.16, 0.20);
const SLATE = rgb(0.32, 0.35, 0.41);
const MUTE = rgb(0.52, 0.55, 0.60);
const LINEC = rgb(0.80, 0.83, 0.87);
const ZEBRA = rgb(0.965, 0.975, 0.98);
const WHITE = rgb(1, 1, 1);

async function generateContractPdf({ title, operator = {}, supplier = {}, intro = '', formalities = '', items = [] }) {
  const pdf = await PDFDocument.create();
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const b = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fi = await pdf.embedFont(StandardFonts.HelveticaOblique);

  // Optional operator logo in the header.
  let logoImg = null;
  if (operator.logo && /^https?:\/\//i.test(operator.logo)) {
    try {
      const resp = await fetch(operator.logo);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('png') || /\.png/i.test(operator.logo)) logoImg = await pdf.embedPng(buf);
        else logoImg = await pdf.embedJpg(buf);
      }
    } catch { /* ignore logo failures */ }
  }

  let page; let y;
  const header = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: PAGE_H - 58, width: PAGE_W, height: 58, color: TEAL });
    page.drawText(sanitize(operator.companyName || 'Service Agreement'), { x: ML, y: PAGE_H - 33, font: b, size: 15, color: WHITE });
    page.drawText('B2B Service Agreement', { x: ML, y: PAGE_H - 47, font: f, size: 9, color: rgb(0.88, 0.95, 0.93) });
    if (logoImg) {
      const h = 34; const w = (logoImg.width / logoImg.height) * h;
      try { page.drawImage(logoImg, { x: PAGE_W - ML - Math.min(w, 120), y: PAGE_H - 46, width: Math.min(w, 120), height: h }); } catch { /* ignore */ }
    }
    page.drawText('Page', { x: PAGE_W - ML - 40, y: 30, font: f, size: 7.5, color: MUTE });
    y = PAGE_H - 86;
  };
  const ensure = (h) => { if (y - h < 60) header(); };
  header();

  const text = (str, { font = f, size = 10, color = SLATE, x = ML, gap = 0 } = {}) => { page.drawText(sanitize(str), { x, y, font, size, color }); y -= gap; };
  const para = (str, { font = f, size = 10, color = SLATE, lh = 14, x = ML, width = CW, gap = 8 } = {}) => {
    const words = sanitize(str).split(/\s+/).filter(Boolean);
    let line = '';
    const flush = () => { ensure(lh); page.drawText(line, { x, y, font, size, color }); y -= lh; };
    for (const w of words) { const t = line ? `${line} ${w}` : w; if (font.widthOfTextAtSize(t, size) > width && line) { flush(); line = w; } else line = t; }
    if (line) flush();
    y -= gap;
  };
  const heading = (str) => {
    y -= 6; ensure(24);
    page.drawText(sanitize(str), { x: ML, y, font: b, size: 12, color: TEAL }); y -= 7;
    page.drawLine({ start: { x: ML, y }, end: { x: PAGE_W - ML, y }, thickness: 0.8, color: LINEC }); y -= 13;
  };

  // ── Title ────────────────────────────────────────────────────────────────
  ensure(40);
  const tt = sanitize(title || 'Service Agreement').toUpperCase();
  const tw = b.widthOfTextAtSize(tt, 17);
  page.drawText(tt, { x: (PAGE_W - tw) / 2, y, font: b, size: 17, color: INK }); y -= 11;
  page.drawLine({ start: { x: (PAGE_W - 130) / 2, y }, end: { x: (PAGE_W + 130) / 2, y }, thickness: 1.6, color: TEAL }); y -= 12;
  const dline = `Dated: ${today()}`;
  page.drawText(dline, { x: (PAGE_W - f.widthOfTextAtSize(dline, 9)) / 2, y, font: fi, size: 9, color: MUTE }); y -= 22;

  // ── Party boxes (side by side) ─────────────────────────────────────────────
  const boxW = (CW - 16) / 2;
  const boxH = 92;
  ensure(boxH + 6);
  const drawParty = (x, label, name, lines) => {
    page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: LINEC, borderWidth: 1, color: rgb(0.99, 0.995, 1) });
    page.drawRectangle({ x, y: y - 20, width: boxW, height: 20, color: TEAL_SOFT });
    page.drawText(label, { x: x + 10, y: y - 14, font: b, size: 8, color: TEAL });
    page.drawText(sanitize(name || '-'), { x: x + 10, y: y - 36, font: b, size: 10.5, color: INK });
    let ly = y - 50;
    lines.filter(Boolean).forEach((ln) => { page.drawText(sanitize(ln).slice(0, 52), { x: x + 10, y: ly, font: f, size: 8.5, color: SLATE }); ly -= 12; });
  };
  drawParty(ML, 'OPERATOR ("the Operator")', operator.companyName, [operator.name, operator.address, [operator.phone, operator.email].filter(Boolean).join('  ')]);
  drawParty(ML + boxW + 16, 'SUPPLIER ("the Supplier")', supplier.companyName, [supplier.supplierName, supplier.phone, supplier.email]);
  y -= boxH + 6;

  // ── Scope ──────────────────────────────────────────────────────────────────
  const introLines = toPlain(intro);
  heading('1. Scope of Agreement');
  if (introLines.length) introLines.forEach((p) => para(p));
  else para('This agreement sets out the activities and the agreed B2B pricing between the Operator and the Supplier as detailed below.');

  // ── Activities table ────────────────────────────────────────────────────────
  heading('2. Activities, Schedule & B2B Pricing');
  const cols = [
    { title: 'Activity', w: 0.30, align: 'left' },
    { title: 'Dates & Slots', w: 0.50, align: 'left' },
    { title: 'B2B Price', w: 0.20, align: 'right' },
  ].map((c) => ({ ...c, width: Math.round(c.w * CW) }));

  const wrap = (str, width, size, font = f) => {
    const words = sanitize(str).split(/\s+/).filter(Boolean);
    const out = []; let line = '';
    for (const w of words) { const t = line ? `${line} ${w}` : w; if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; } else line = t; }
    if (line) out.push(line);
    return out.length ? out : [''];
  };

  const headerRow = () => {
    const rh = 20; ensure(rh + 2);
    page.drawRectangle({ x: ML, y: y - rh + 5, width: CW, height: rh, color: TEAL });
    let x = ML;
    cols.forEach((c) => {
      const tx = c.align === 'right' ? x + c.width - b.widthOfTextAtSize(c.title, 8.5) - 6 : x + 6;
      page.drawText(c.title, { x: tx, y: y - 9, font: b, size: 8.5, color: WHITE });
      x += c.width;
    });
    y -= rh;
  };
  headerRow();

  if (!items.length) {
    para('No activities selected.', { font: fi, color: MUTE, gap: 6 });
  } else {
    items.forEach((it, ri) => {
      const nameLines = wrap(it.name || '-', cols[0].width - 12, 9);
      const sched = scheduleLines(it.dates);
      const schedWrapped = sched.length ? sched.flatMap((s) => wrap(s, cols[1].width - 12, 8.5)) : ['No dates set'];
      const rows = Math.max(nameLines.length, schedWrapped.length, 1);
      const rh = rows * 11 + 10;
      if (y - rh < 60) { header(); headerRow(); }
      if (ri % 2 === 1) page.drawRectangle({ x: ML, y: y - rh + 5, width: CW, height: rh, color: ZEBRA });
      // cells
      let cy = y - 10;
      nameLines.forEach((ln) => { page.drawText(ln, { x: ML + 6, y: cy, font: b, size: 9, color: INK }); cy -= 11; });
      let sy = y - 10;
      schedWrapped.forEach((ln) => { page.drawText(ln, { x: ML + cols[0].width + 6, y: sy, font: f, size: 8.5, color: SLATE }); sy -= 11; });
      const priceStr = money(it.b2bPrice);
      page.drawText(priceStr, { x: ML + cols[0].width + cols[1].width + cols[2].width - b.widthOfTextAtSize(priceStr, 9.5) - 6, y: y - 10, font: b, size: 9.5, color: TEAL });
      page.drawLine({ start: { x: ML, y: y - rh + 5 }, end: { x: PAGE_W - ML, y: y - rh + 5 }, thickness: 0.4, color: LINEC });
      y -= rh;
    });
    // column separators across the table would need full-height tracking; keep rows clean with row separators only.
  }
  y -= 12;

  // ── Formalities ─────────────────────────────────────────────────────────────
  const formLines = toPlain(formalities);
  if (formLines.length) { heading('3. Terms & Formalities'); formLines.forEach((p) => para(p)); }

  // ── Signatures ──────────────────────────────────────────────────────────────
  y -= 18; ensure(110);
  const colX2 = ML + CW / 2 + 10;
  const sy = y;
  page.drawText('For the Operator', { x: ML, y: sy, font: f, size: 9, color: MUTE });
  page.drawText('For the Supplier', { x: colX2, y: sy, font: f, size: 9, color: MUTE });
  const ly = sy - 56;
  page.drawLine({ start: { x: ML, y: ly }, end: { x: ML + 190, y: ly }, thickness: 1, color: SLATE });
  page.drawLine({ start: { x: colX2, y: ly }, end: { x: colX2 + 190, y: ly }, thickness: 1, color: SLATE });
  page.drawText(sanitize(operator.name || 'Authorised Signatory'), { x: ML, y: ly - 14, font: b, size: 9.5, color: INK });
  if (operator.companyName) page.drawText(sanitize(operator.companyName), { x: ML, y: ly - 26, font: f, size: 8.5, color: MUTE });
  if (operator.phone) page.drawText(sanitize(operator.phone), { x: ML, y: ly - 38, font: f, size: 8.5, color: MUTE });
  page.drawText(sanitize(supplier.supplierName || supplier.companyName || 'Authorised Signatory'), { x: colX2, y: ly - 14, font: b, size: 9.5, color: INK });
  if (supplier.companyName) page.drawText(sanitize(supplier.companyName), { x: colX2, y: ly - 26, font: f, size: 8.5, color: MUTE });
  if (supplier.phone) page.drawText(sanitize(supplier.phone), { x: colX2, y: ly - 38, font: f, size: 8.5, color: MUTE });

  return Buffer.from(await pdf.save());
}

// ── Word-compatible HTML (.doc) ──────────────────────────────────────────────
function generateContractDoc({ title, operator = {}, supplier = {}, intro = '', formalities = '', items = [] }) {
  const rowsHtml = items.length
    ? items.map((it) => {
      const sched = scheduleLines(it.dates);
      const schedHtml = sched.length ? sched.map((s) => esc(s)).join('<br>') : '<span style="color:#9ca3af">No dates set</span>';
      return `<tr>
        <td style="font-weight:bold">${esc(it.name)}</td>
        <td style="font-size:9.5pt">${schedHtml}</td>
        <td style="text-align:right;font-weight:bold;color:#0f766e;white-space:nowrap">${esc(money(it.b2bPrice))}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="3"><i>No activities selected.</i></td></tr>';

  const block = (s) => {
    if (!s || !s.trim()) return '';
    return /<[a-z]/i.test(s) ? s : toPlain(s).map((p) => `<p>${esc(p)}</p>`).join('');
  };
  const introHtml = block(intro) || '<p>This agreement sets out the activities and agreed B2B pricing between the Operator and the Supplier as detailed below.</p>';
  const formHtml = block(formalities);

  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(title || 'Service Agreement')}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  @page { size: A4; margin: 2cm; }
  body { font-family:'Calibri',Arial,sans-serif; color:#23262d; font-size:11pt; line-height:1.45; }
  .band { background:#0b766d; color:#fff; padding:14px 18px; }
  .band .co { font-size:15pt; font-weight:bold; }
  .band .sub { font-size:9pt; color:#cfeae6; }
  h1 { text-align:center; color:#14171c; font-size:18pt; margin:18px 0 2px; letter-spacing:1px; }
  .rule { width:130px; height:3px; background:#0b766d; margin:0 auto 4px; }
  .dated { text-align:center; color:#6b7280; font-style:italic; font-size:9.5pt; margin-bottom:18px; }
  h2 { color:#0b766d; font-size:13pt; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin:18px 0 8px; }
  .parties { width:100%; border-collapse:collapse; margin-bottom:6px; }
  .parties td { width:50%; vertical-align:top; border:1px solid #cbd5e1; padding:0; }
  .pt-head { background:#e6f2f0; color:#0b766d; font-weight:bold; font-size:8.5pt; padding:5px 10px; }
  .pt-body { padding:8px 10px; }
  .pt-body .nm { font-weight:bold; font-size:11pt; color:#14171c; }
  .pt-body .ln { font-size:9pt; color:#475569; }
  table.acts { border-collapse:collapse; width:100%; margin:6px 0; }
  table.acts th { background:#0b766d; color:#fff; text-align:left; font-size:9.5pt; padding:7px 8px; }
  table.acts th.r, table.acts td.r { text-align:right; }
  table.acts td { border-bottom:1px solid #e2e8f0; padding:7px 8px; vertical-align:top; font-size:10pt; }
  table.acts tr:nth-child(even) td { background:#f7fafc; }
  .sig { width:100%; margin-top:48px; border-collapse:collapse; }
  .sig td { width:50%; vertical-align:top; padding-right:24px; }
  .siglabel { color:#6b7280; font-size:9pt; }
  .sigline { border-top:1px solid #555; width:80%; margin-top:46px; padding-top:5px; }
</style></head>
<body>
  <div class="band"><div class="co">${esc(operator.companyName || 'Service Agreement')}</div><div class="sub">B2B Service Agreement</div></div>
  <h1>${esc((title || 'Service Agreement').toUpperCase())}</h1>
  <div class="rule"></div>
  <div class="dated">Dated: ${esc(today())}</div>

  <table class="parties">
    <tr>
      <td><div class="pt-head">OPERATOR ("the Operator")</div><div class="pt-body"><div class="nm">${esc(operator.companyName || '-')}</div>${operator.name ? `<div class="ln">${esc(operator.name)}</div>` : ''}${operator.address ? `<div class="ln">${esc(operator.address)}</div>` : ''}<div class="ln">${esc([operator.phone, operator.email].filter(Boolean).join('  |  '))}</div></div></td>
      <td><div class="pt-head">SUPPLIER ("the Supplier")</div><div class="pt-body"><div class="nm">${esc(supplier.companyName || '-')}</div>${supplier.supplierName ? `<div class="ln">${esc(supplier.supplierName)}</div>` : ''}<div class="ln">${esc([supplier.phone, supplier.email].filter(Boolean).join('  |  '))}</div></div></td>
    </tr>
  </table>

  <h2>1. Scope of Agreement</h2>
  ${introHtml}

  <h2>2. Activities, Schedule &amp; B2B Pricing</h2>
  <table class="acts">
    <tr><th>Activity</th><th>Dates &amp; Slots</th><th class="r">B2B Price</th></tr>
    ${rowsHtml}
  </table>

  ${formHtml ? `<h2>3. Terms &amp; Formalities</h2>${formHtml}` : ''}

  <table class="sig">
    <tr>
      <td><div class="siglabel">For the Operator</div><div class="sigline"></div><b>${esc(operator.name || 'Authorised Signatory')}</b><br><span class="ln">${esc(operator.companyName || '')}</span><br>${esc(operator.phone || '')}</td>
      <td><div class="siglabel">For the Supplier</div><div class="sigline"></div><b>${esc(supplier.supplierName || supplier.companyName || 'Authorised Signatory')}</b><br><span class="ln">${esc(supplier.companyName || '')}</span><br>${esc(supplier.phone || '')}</td>
    </tr>
  </table>
</body></html>`;
  return Buffer.from(html, 'utf-8');
}

module.exports = { generateContractPdf, generateContractDoc };

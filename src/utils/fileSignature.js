/*
  File-signature (magic-byte) verification.

  Extension + MIME are both CLIENT-CONTROLLED, so `virus.exe` renamed to
  `resume.pdf` with a spoofed `application/pdf` header passes any name/MIME
  check. The only trustworthy signal is the file's actual first bytes. This
  reads the buffer we already hold in memory and returns the REAL type — an
  .exe (MZ header) or anything not on our known-safe list is rejected before it
  ever leaves the server.

  Kept dependency-free: a handful of well-known signatures covers every format
  the platform accepts (images, video, PDF, Office docs).
*/

const startsWith = (buf, bytes, offset = 0) => {
  if (!buf || buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buf[offset + i] !== bytes[i]) return false;
  return true;
};

const hasAscii = (buf, str, offset = 0) => startsWith(buf, [...str].map((c) => c.charCodeAt(0)), offset);

/*
  Detect the true type from magic bytes. Returns a canonical token
  (jpg/png/gif/webp/mp4/mov/webm/avi/pdf/docx/doc) or null when the content is
  not a recognised, allowed format.
*/
const detectType = (buf) => {
  if (!buf || buf.length < 4) return null;

  // Images
  if (startsWith(buf, [0xFF, 0xD8, 0xFF])) return 'jpg';
  if (startsWith(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png';
  if (hasAscii(buf, 'GIF87a') || hasAscii(buf, 'GIF89a')) return 'gif';
  if (hasAscii(buf, 'RIFF') && hasAscii(buf, 'WEBP', 8)) return 'webp';

  // Video / containers
  if (hasAscii(buf, 'ftyp', 4)) {
    const brand = buf.slice(8, 12).toString('ascii');
    if (/^(qt)/i.test(brand)) return 'mov';
    return 'mp4'; // isom / mp42 / M4V / etc.
  }
  if (startsWith(buf, [0x1A, 0x45, 0xDF, 0xA3])) return 'webm'; // Matroska/WebM (EBML)
  if (hasAscii(buf, 'RIFF') && hasAscii(buf, 'AVI ', 8)) return 'avi';

  // Documents
  if (hasAscii(buf, '%PDF')) return 'pdf';
  if (startsWith(buf, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return 'doc'; // OLE (legacy .doc)
  if (startsWith(buf, [0x50, 0x4B, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4B, 0x05, 0x06])) return 'docx'; // ZIP (docx/xlsx/pptx)

  return null; // unknown / not allowed (covers .exe MZ, ELF, scripts, etc.)
};

// The allow-list regexes use these ext spellings — map detected → what to test.
const ALIASES = {
  jpg: ['jpg', 'jpeg'],
  png: ['png'],
  gif: ['gif'],
  webp: ['webp'],
  mp4: ['mp4'],
  mov: ['mov'],
  webm: ['webm'],
  avi: ['avi'],
  pdf: ['pdf'],
  docx: ['docx', 'doc'], // a ZIP-based Office doc satisfies a doc/docx allow-list
  doc: ['doc', 'docx'],
};

/*
  Verify a buffer's REAL content is one of the types this uploader allows.
  `allowed` is the same RegExp the fileFilter uses. Returns { ok } or
  { ok:false, reason }.
*/
const verifyContent = (buffer, allowed) => {
  const detected = detectType(buffer);
  if (!detected) {
    return { ok: false, reason: 'File content is not a recognised image, video or document (its bytes don\'t match its name).' };
  }
  const tokens = ALIASES[detected] || [detected];
  const permitted = tokens.some((t) => allowed.test(t));
  if (!permitted) {
    return { ok: false, reason: `File content is a ${detected.toUpperCase()}, which isn't allowed here.` };
  }
  return { ok: true, detected };
};

module.exports = { detectType, verifyContent };

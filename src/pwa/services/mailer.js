const http = require('http');
const https = require('https');
const nodemailer = require('nodemailer');

const FROM = () =>
  process.env.MAIL_FROM ||
  process.env.EMAIL_FROM ||
  process.env.SMTP_FROM ||
  process.env.BREVO_FROM ||
  'Retreats by Traveon <no-reply@traveon.com>';

// Provider-agnostic SMTP transport (nodemailer). Works with ANY provider —
// Resend, SendGrid, Mailgun, Zoho, Gmail, or your own cPanel mailbox — using
// plain SMTP credentials. Unlike Brevo's transactional API, SMTP auth is NOT
// tied to an IP allow-list, so it never breaks on a changing/unknown server IP.
// Activated automatically the moment SMTP_HOST is present in the environment.
let _transport = null;
const getSmtpTransport = () => {
  if (_transport !== null) return _transport;
  if (!process.env.SMTP_HOST) { _transport = false; return false; }
  const host = String(process.env.SMTP_HOST).trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  // The server's OWN mail server (localhost / mail.<domain>) often uses a
  // self-signed cert and accepts local mail without auth — relax cert checks
  // so cPanel/Exim relays don't throw on the TLS handshake.
  const isLocalRelay = /^(localhost|127\.0\.0\.1|::1|mail\.)/i.test(host);
  _transport = nodemailer.createTransport({
    host,
    port,
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true' || port === 465,
    auth: process.env.SMTP_USER
      // Strip spaces — Gmail shows app passwords as "abcd efgh ijkl mnop" but
      // the actual secret has no spaces; pasting them verbatim breaks AUTH.
      ? { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS || '').replace(/\s+/g, '') }
      : undefined,
    ...(isLocalRelay ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
  return _transport;
};

const parseAddress = (value) => {
  const address = String(value || '').trim().replace(/^"|"$/g, '');
  const match = address.match(/^(.*?)\s*<([^>]+)>$/);
  if (!match) return { email: address };

  const name = match[1].replace(/^"|"$/g, '').trim();
  return { name, email: match[2].trim() };
};

const parseRecipients = (value) =>
  String(value || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

const postBrevoEmail = (payload) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        // Force IPv4 — Brevo's IP whitelist is per-address and our ISP's
        // dynamic IPv6 prefix would need re-whitelisting on every reconnect.
        family: 4,
        headers: {
          accept: 'application/json',
          // Strip any stray whitespace/newline a pasted env var may carry —
          // otherwise Node throws "Invalid character in header content".
          'api-key': String(process.env.BREVO_API_KEY || '').replace(/\s+/g, ''),
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          const details = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
          reject(new Error(`Brevo email failed (${res.statusCode}): ${details}`));
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });

const downloadUrl = (url) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Could not download attachment (${res.statusCode})`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });

const send = async ({ to, subject, html, text, replyTo, attachments }) => {
  const recipients = parseRecipients(to || process.env.SMTP_TO || process.env.SMTP_To);
  if (!recipients.length) {
    throw new Error('Email recipient missing. Pass `to` or set SMTP_TO in .env');
  }

  // 1) Preferred: Brevo transactional HTTP API. Hosts like Render block
  //    outbound SMTP (ports 25/465/587), so when a Brevo API key is present we
  //    send over HTTPS — which is never blocked. API-key auth is not tied to an
  //    IP allow-list, so it works from any (even changing) server IP.
  if (process.env.BREVO_API_KEY) {
    return postBrevoEmail({
      sender: parseAddress(FROM()),
      to: recipients,
      replyTo: replyTo ? parseAddress(replyTo) : undefined,
      subject,
      htmlContent: html,
      textContent: text,
      attachment: attachments?.map((attachment) => ({
        name: attachment.filename,
        content: Buffer.from(attachment.content).toString('base64'),
      })),
    });
  }

  // 2) Fallback: plain SMTP (any provider) — used in environments where SMTP is
  //    allowed and no Brevo key is configured (e.g. local dev with Gmail).
  const transport = getSmtpTransport();
  if (transport) {
    return transport.sendMail({
      from: FROM(),
      to: recipients.map((r) => r.email).join(', '),
      replyTo: replyTo || undefined,
      subject,
      html,
      text,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content),
      })),
    });
  }

  throw new Error('No email transport configured. Set BREVO_API_KEY (preferred) or SMTP_HOST (+ SMTP_USER/SMTP_PASS) in .env');
};

// Convenience helpers keep templates inline so they can later move out
// without touching callers.

const sendOtp = ({ to, code, purpose, role }) => {
  const purposeLabel = {
    signup_verify: 'verify your account',
    login: 'log in',
    reset: 'reset your password',
    owner_login: 'access your property',
  }[purpose] || 'authenticate';

  const subject = `Your Traveon Retreats verification code: ${code}`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">Verification code</h2>
      <p style="color:#374151;line-height:1.55;">
        Use the code below to ${purposeLabel}${role ? ` as <strong>${role}</strong>` : ''}.
      </p>
      <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f0fdfa;padding:18px 24px;text-align:center;border-radius:10px;color:#0f766e;margin:18px 0;">
        ${code}
      </div>
      <p style="color:#6b7280;font-size:13px;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
    </div>
  `;
  return send({ to, subject, html, text: `Your code: ${code}` });
};

const sendInvite = ({ to, name, role, tempPassword, loginUrl }) => {
  const subject = `Welcome to Traveon Retreats - your ${role} account is ready`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">Welcome${name ? `, ${name}` : ''}!</h2>
      <p style="color:#374151;line-height:1.55;">
        An administrator has created a <strong>${role}</strong> account for you in the
        Traveon Retreats app. Use the credentials below to sign in.
      </p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 12px;color:#6b7280;">Email</td><td style="padding:6px 12px;font-weight:600;">${to}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Temporary password</td><td style="padding:6px 12px;font-weight:600;font-family:monospace;">${tempPassword}</td></tr>
      </table>
      ${loginUrl ? `<p><a href="${loginUrl}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;">Open the app</a></p>` : ''}
      <p style="color:#6b7280;font-size:13px;margin-top:18px;">You will be asked to verify your email and change your password on first login.</p>
    </div>
  `;
  return send({ to, subject, html, text: `Welcome! Temp password: ${tempPassword}` });
};

const sendContract = async ({
  to,
  ownerName,
  propertyName,
  propertyCode,
  pdfBuffer,
  pdfUrl,
  pdfFilename,
  subject,
  heading = 'Your contract is ready',
  intro,
  instructions,
}) => {
  const attachmentBuffer = pdfBuffer || (pdfUrl ? await downloadUrl(pdfUrl) : null);
  const mailSubject = subject || `Contract for ${propertyName} (${propertyCode}) - Traveon Retreats`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">${heading}</h2>
      <p style="color:#374151;line-height:1.55;">
        Hello${ownerName ? ` ${ownerName}` : ''}, ${intro || `your property <strong>${propertyName}</strong> has been approved.`}
      </p>
      <p style="color:#374151;line-height:1.55;">
        ${instructions || 'The contract is attached to this email as a PDF. Please print it, sign it, and upload the signed copy in the Traveon Retreats app using your Property ID below.'}
      </p>
      <div style="font-size:18px;font-weight:700;letter-spacing:2px;background:#f0fdfa;padding:14px 18px;text-align:center;border-radius:10px;color:#0f766e;margin:18px 0;">
        Property ID: ${propertyCode}
      </div>
      <p style="color:#6b7280;font-size:13px;">If you have any questions, reply to this email.</p>
    </div>
  `;
  return send({
    to,
    subject: mailSubject,
    html,
    attachments: attachmentBuffer
      ? [{ filename: pdfFilename || `contract-${propertyCode}.pdf`, content: attachmentBuffer }]
      : undefined,
  });
};

const filenameFromUrl = (url, fallback) => {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split('/').filter(Boolean).pop();
    const decoded = name ? decodeURIComponent(name) : '';
    return /\.[a-z0-9]+$/i.test(decoded) ? decoded : fallback;
  } catch {
    return fallback;
  }
};

const sendSignedContractNotification = async ({
  to,
  ownerEmail,
  ownerName,
  propertyName,
  propertyCode,
  signedUrl,
  auditor,
  officer,
}) => {
  const attachment = signedUrl
    ? await downloadUrl(signedUrl).then((content) => ({
        filename: filenameFromUrl(signedUrl, `signed-contract-${propertyCode}.pdf`),
        content,
      }))
    : null;

  const subject = `Signed contract uploaded - ${propertyName} (${propertyCode})`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">Signed contract uploaded</h2>
      <p style="color:#374151;line-height:1.55;">
        The property owner has uploaded a signed contract. The file is attached to this email.
      </p>
      <table style="border-collapse:collapse;margin:16px 0;width:100%;font-size:14px;">
        <tr><td style="padding:6px 12px;color:#6b7280;">Property</td><td style="padding:6px 12px;font-weight:600;">${propertyName}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Property ID</td><td style="padding:6px 12px;font-weight:600;">${propertyCode}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Owner</td><td style="padding:6px 12px;font-weight:600;">${ownerName || '-'} &lt;${ownerEmail}&gt;</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Auditor</td><td style="padding:6px 12px;font-weight:600;">${auditor?.name || '-'}${auditor?.email ? ` &lt;${auditor.email}&gt;` : ''}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Officer</td><td style="padding:6px 12px;font-weight:600;">${officer?.name || '-'}${officer?.email ? ` &lt;${officer.email}&gt;` : ''}</td></tr>
      </table>
      ${signedUrl ? `<p style="font-size:13px;color:#6b7280;">Backup link: <a href="${signedUrl}">${signedUrl}</a></p>` : ''}
    </div>
  `;

  return send({
    to,
    replyTo: ownerEmail,
    subject,
    html,
    text: `Signed contract uploaded for ${propertyName} (${propertyCode}) by ${ownerEmail}. ${signedUrl || ''}`,
    attachments: attachment ? [attachment] : undefined,
  });
};

// Sent to the owner once the signed contract lands and the property is
// flipped to COMPLETED. Acts as the "your retreat is live" receipt.
const sendListingConfirmation = ({ to, ownerName, propertyName, propertyCode }) => {
  const subject = `${propertyName} is now live on Retreats by Traveon`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#0f766e;">Your retreat is live</h2>
      <p style="color:#374151;line-height:1.55;">
        Hello${ownerName ? ` ${ownerName}` : ''}, we've received your signed contract
        for <strong>${propertyName}</strong>. Onboarding is complete and your
        property is now live on the Retreats by Traveon platform.
      </p>
      <div style="font-size:18px;font-weight:700;letter-spacing:2px;background:#f0fdfa;padding:14px 18px;text-align:center;border-radius:10px;color:#0f766e;margin:18px 0;">
        Property ID: ${propertyCode || '—'}
      </div>
      <p style="color:#6b7280;font-size:13px;">
        You can manage availability and inquiries from the owner app at any
        time. Welcome aboard!
      </p>
    </div>
  `;
  return send({
    to,
    subject,
    html,
    text: `${propertyName} (${propertyCode || ''}) is now live on Retreats by Traveon.`,
  });
};

module.exports = {
  send,
  sendOtp,
  sendInvite,
  sendContract,
  sendSignedContractNotification,
  sendListingConfirmation,
};

/*
  Best-effort capture of the request's client fingerprint for the
  fraud-detection system. Everything here is derived from the request the USER
  makes (booking create), so it's the real user's IP / device — not Cashfree's
  server, which is what fires the later webhook.

  Server-side we can always get IP + User-Agent (→ a readable system summary).
  Richer signals (deviceId, precise location, network type) can only come from
  the client; we accept them if the app chose to send them (`body.clientContext`
  or individual fields) but never require them, so no client change is needed
  for the core detection to work.
*/

// Pull the real client IP even behind a proxy. `trust proxy` is set on the app
// so req.ip is already correct, but we also read X-Forwarded-For's first hop
// defensively.
const ipOf = (req) => {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.connection?.remoteAddress || null;
};

// A short human-readable summary of the browser/OS from the UA string.
const systemFromUA = (ua) => {
  const s = String(ua || '');
  if (!s) return null;
  const os = /Windows NT 10/.test(s) ? 'Windows 10/11'
    : /Windows NT/.test(s) ? 'Windows'
      : /Android/.test(s) ? (s.match(/Android[ ]?[\d.]+/)?.[0] || 'Android')
        : /iPhone|iPad|iOS/.test(s) ? 'iOS'
          : /Mac OS X/.test(s) ? 'macOS'
            : /Linux/.test(s) ? 'Linux' : 'Unknown OS';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /Chrome\//.test(s) ? 'Chrome'
      : /Firefox\//.test(s) ? 'Firefox'
        : /Safari\//.test(s) ? 'Safari'
          : /okhttp|ReactNative|Expo/i.test(s) ? 'Mobile app' : 'Unknown browser';
  return `${browser} · ${os}`;
};

const captureClientContext = (req) => {
  const body = (req && req.body) || {};
  // The app may send a { clientContext: {...} } bag or loose fields — accept both.
  const cc = body.clientContext && typeof body.clientContext === 'object' ? body.clientContext : {};
  const pick = (a, b) => (a !== undefined && a !== null && a !== '' ? a : (b !== undefined ? b : null));

  const ua = req.headers['user-agent'] || null;
  return {
    ip: ipOf(req),
    userAgent: ua,
    systemInfo: pick(cc.systemInfo, systemFromUA(ua)),
    deviceId: pick(cc.deviceId, body.deviceId),
    location: pick(cc.location, body.location) || null, // { lat, lng, city, ... } if the client sends it
    network: pick(cc.network, body.network) || null, // 'wifi' | 'cellular' | carrier, if sent
    acceptLanguage: req.headers['accept-language'] || null,
    capturedAt: new Date().toISOString(),
  };
};

module.exports = { captureClientContext, ipOf, systemFromUA };

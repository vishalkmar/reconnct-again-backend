const crypto = require('crypto');

/*
  Signed handle for one dispatch row, carried by the tracking pixel and the
  click link in a greeting email.

  Signed rather than a bare id for one reason: these URLs sit in inboxes
  forever and are trivially enumerable. A raw `?d=1841` would let anyone walk
  the table and mark every greeting as opened and clicked, which would not
  breach anything but WOULD quietly turn the analytics dashboard into
  fiction — and a metric nobody can trust is worse than no metric.

  Same shape and the same reasoning as unsubscribeToken.js: an HMAC, not a
  JWT. This must never be usable as a credential anywhere else in the system,
  so it is scoped by a literal prefix that appears in no other signature.
*/

const secret = () =>
  process.env.CAMPAIGN_TRACK_SECRET || process.env.JWT_SECRET || 'reconnct-campaign-track';

const sign = (dispatchId) =>
  crypto.createHmac('sha256', secret()).update(`camp:${dispatchId}`).digest('hex').slice(0, 24);

const makeTrackToken = (dispatchId) => `${dispatchId}.${sign(dispatchId)}`;

/** Returns the dispatch id, or null when the token is malformed or forged. */
const readTrackToken = (token) => {
  const [rawId, mac] = String(token || '').split('.');
  const id = Number(rawId);
  if (!id || !mac) return null;
  const expected = sign(id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
};

module.exports = { makeTrackToken, readTrackToken };

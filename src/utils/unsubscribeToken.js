const crypto = require('crypto');

/*
  One-click opt-out link for occasion emails. The token is an HMAC over the
  user id — no DB row, no expiry to manage, and nothing guessable: knowing
  user #42 exists is not enough to unsubscribe them.

  Deliberately NOT a JWT: this link lives forever in someone's inbox, and it
  must never be accepted as a login credential anywhere in the system.
*/

const secret = () =>
  process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'reconnct-unsub';

const sign = (userId) =>
  crypto.createHmac('sha256', secret()).update(`unsub:${userId}`).digest('hex').slice(0, 32);

const makeToken = (userId) => `${userId}.${sign(userId)}`;

/** Returns the user id, or null when the token is malformed/forged. */
const readToken = (token) => {
  const [rawId, mac] = String(token || '').split('.');
  const id = Number(rawId);
  if (!id || !mac) return null;
  const expected = sign(id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
};

module.exports = { makeToken, readToken };

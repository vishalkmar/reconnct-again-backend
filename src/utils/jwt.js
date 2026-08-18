const jwt = require('jsonwebtoken');

// Every token this platform issues is symmetric HS256. Pinning the algorithm on
// BOTH sign and verify closes the classic "algorithm confusion" forgery, where
// a token's own header claims a different alg (e.g. alg:'none', or RS256 abused
// against a symmetric secret) and a permissive verifier accepts it. Shared by
// every auth middleware via verifyAuthToken so the whole surface is consistent.
const JWT_ALG = 'HS256';

const signToken = (payload, options = {}) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: JWT_ALG,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    ...options,
  });

// The one verify used everywhere — rejects any token not signed HS256.
const verifyAuthToken = (token) => jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALG] });

// Back-compat alias (older imports call verifyToken).
const verifyToken = verifyAuthToken;

module.exports = { signToken, verifyToken, verifyAuthToken, JWT_ALG };

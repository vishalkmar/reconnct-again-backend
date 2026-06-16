const jwt = require('jsonwebtoken');

const signToken = (payload, options = {}) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    ...options,
  });

const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

module.exports = { signToken, verifyToken };

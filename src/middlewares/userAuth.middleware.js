const jwt = require('jsonwebtoken');
const { User } = require('../models');

const extractToken = (req) => {
  // Prefer the dedicated user header so admin & user tokens never collide
  // on a request that happens to carry both.
  const userHeader = req.headers['x-user-auth'] || req.headers['X-User-Auth'];
  if (userHeader) {
    return String(userHeader).startsWith('Bearer ')
      ? String(userHeader).slice(7)
      : String(userHeader);
  }
  return null;
};

const authenticateUser = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.kind !== 'user') {
      return res.status(401).json({ success: false, message: 'Invalid token kind' });
    }

    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid or inactive user' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// "Soft" variant — populates req.user when a valid token is present but never
// blocks the request. Useful for endpoints that need to differentiate guest vs
// signed-in but should still serve guests.
const optionalUser = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.kind === 'user') {
      const user = await User.findByPk(decoded.id);
      if (user && user.isActive) req.user = user;
    }
  } catch {
    /* ignore — guest */
  }
  next();
};

module.exports = { authenticateUser, optionalUser };

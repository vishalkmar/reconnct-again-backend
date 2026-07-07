const jwt = require('jsonwebtoken');
const { User } = require('../models');

const stripBearer = (v) => (String(v).startsWith('Bearer ') ? String(v).slice(7) : String(v));

const extractToken = (req) => {
  // Prefer the dedicated user header so admin & user tokens never collide
  // on a request that happens to carry both (the website sends this).
  const userHeader = req.headers['x-user-auth'] || req.headers['X-User-Auth'];
  if (userHeader) return stripBearer(userHeader);
  // Fallback: the mobile app sends the user token on the standard Authorization
  // header. It's still verified as a `kind:'user'` token below, so an admin
  // token here simply fails the kind check — no privilege crossover.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader) return stripBearer(authHeader);
  // Last resort: a `?token=` query param. Only needed for links opened by the
  // OS (e.g. the app's "Download voucher" button uses Linking.openURL, which
  // can't attach a custom header) — never required for normal fetch() calls.
  if (req.query && req.query.token) return stripBearer(req.query.token);
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

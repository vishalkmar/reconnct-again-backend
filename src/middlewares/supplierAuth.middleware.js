const jwt = require('jsonwebtoken');
const { Supplier, User } = require('../models');

// Fourth parallel to authenticate (admin) / authenticateUser (user) /
// authenticateTeamMember (staff) — a Supplier's own login. Own JWT
// `kind:'supplier'` riding on its own `X-Supplier-Auth` header, same idea as
// X-User-Auth / X-Team-Auth, so it never collides with another session in
// the same browser. Mounted on a SEPARATE route tree from /api/host/* (which
// stays authenticateUser-only, completely unchanged) — the two share the
// same underlying host.controller.js functions, which resolve ownership
// from whichever of req.user / req.supplier is set.
const authenticateSupplier = async (req, res, next) => {
  try {
    const header = req.headers['x-supplier-auth'] || req.headers['X-Supplier-Auth'] || '';
    const token = String(header).replace(/^Bearer\s+/i, '') || null;
    if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.kind !== 'supplier') {
      return res.status(401).json({ success: false, message: 'Invalid token kind' });
    }

    const supplier = await Supplier.findByPk(decoded.id);
    if (!supplier || !supplier.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid or inactive account' });
    }

    req.supplier = supplier;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const stripBearer = (v) => (String(v).startsWith('Bearer ') ? String(v).slice(7) : String(v));

// A couple of Host-system-adjacent endpoints (e.g. the listing wizard's
// photo uploader) are shared verbatim by the Supplier Portal and need to
// accept EITHER token. Tries the user token first (X-User-Auth/Authorization
// — unchanged path for Host), falls back to supplier. Never delegates to
// authenticateUser()/authenticateSupplier() directly since those send their
// own 401 response on failure instead of letting a wrapper fall through.
const authenticateUserOrSupplier = async (req, res, next) => {
  try {
    const userHeader = req.headers['x-user-auth'] || req.headers['X-User-Auth'] || req.headers.authorization;
    if (userHeader) {
      const token = stripBearer(userHeader);
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.kind === 'user') {
          const user = await User.findByPk(decoded.id);
          if (user && user.isActive) {
            req.user = user;
            return next();
          }
        }
      } catch {
        /* fall through to supplier check below */
      }
    }
    return authenticateSupplier(req, res, next);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

module.exports = { authenticateSupplier, authenticateUserOrSupplier };

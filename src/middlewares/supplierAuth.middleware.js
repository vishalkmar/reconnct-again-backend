const jwt = require('jsonwebtoken');
const { Supplier, User } = require('../models');

const stripBearer = (v) => (String(v).startsWith('Bearer ') ? String(v).slice(7) : String(v));

// Fourth parallel to authenticate (admin) / authenticateUser (user) /
// authenticateTeamMember (staff) — a Supplier's own login. Own JWT
// `kind:'supplier'`. The WEB Supplier Portal sends it on its own
// `X-Supplier-Auth` header (same idea as X-User-Auth/X-Team-Auth, so it
// never collides with another session in the same browser); the MOBILE APP
// has no such per-role header convention (its api/client.js always sends
// whatever token it has on the plain `Authorization` header, same as it
// already does for the user token) — so this checks X-Supplier-Auth FIRST,
// then falls back to Authorization. Mounted on a SEPARATE route tree from
// /api/host/* (which stays authenticateUser-only, completely unchanged) —
// the two share the same underlying host.controller.js functions, which
// resolve ownership from whichever of req.user / req.supplier is set.
const authenticateSupplier = async (req, res, next) => {
  try {
    const header = req.headers['x-supplier-auth'] || req.headers['X-Supplier-Auth'] || req.headers.authorization || '';
    const token = stripBearer(header) || null;
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

// A couple of Host-system-adjacent endpoints (e.g. the listing wizard's
// photo uploader) are shared verbatim by the Supplier Portal (web + app)
// and need to accept EITHER a user token OR a supplier token, wherever
// each one happens to be sent (X-User-Auth/X-Supplier-Auth on web,
// Authorization on the app for either). Tries user first, falls back to
// supplier. Never delegates to authenticateUser()/authenticateSupplier()
// directly since those send their own 401 response on failure instead of
// letting a wrapper fall through to the next strategy.
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

const jwt = require('jsonwebtoken');
const { Auditor, Officer, PropertyOwner } = require('../models');

// Verifies a PWA JWT (issued with { pwa: true, role, id }) and loads the
// associated record onto req. `requireRoles(...)` is a convenience wrapper:
//   router.get('/x', authenticatePwa, requireRoles('auditor'), handler)

const authenticatePwa = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.pwa) {
      return res.status(401).json({ success: false, message: 'Wrong token scope' });
    }

    let user = null;
    if (decoded.role === 'auditor') user = await Auditor.findByPk(decoded.id);
    else if (decoded.role === 'officer') user = await Officer.findByPk(decoded.id);
    else if (decoded.role === 'owner') user = await PropertyOwner.findByPk(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Account no longer exists' });
    }
    if (user.isActive === false) {
      return res.status(401).json({ success: false, message: 'Account deactivated' });
    }

    req.pwaUser = user;
    req.pwaRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const requireRoles = (...roles) => (req, res, next) => {
  if (!req.pwaRole || !roles.includes(req.pwaRole)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  next();
};

module.exports = { authenticatePwa, requireRoles };

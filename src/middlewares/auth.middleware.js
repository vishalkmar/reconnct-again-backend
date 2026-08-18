const jwt = require('jsonwebtoken');
const { verifyAuthToken } = require('../utils/jwt');
const { Admin } = require('../models');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const decoded = verifyAuthToken(token);

    // CRITICAL: every token this platform issues is signed with the SAME secret,
    // so a user / supplier / team-member token verifies here too. Without a kind
    // check, any such token whose `id` collides with an admin id would be
    // accepted AS THAT ADMIN (a customer #1 → admin #1 privilege escalation).
    // Admin tokens now carry kind:'admin'; legacy admin tokens (issued before
    // this field existed) have NO kind and are still allowed, while any token
    // that declares a non-admin kind is rejected outright.
    if (decoded.kind && decoded.kind !== 'admin') {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const admin = await Admin.findByPk(decoded.id);

    if (!admin || !admin.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid or inactive admin' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.admin || !roles.includes(req.admin.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  next();
};

module.exports = { authenticate, authorize };

const jwt = require('jsonwebtoken');
const { Admin } = require('../models');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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

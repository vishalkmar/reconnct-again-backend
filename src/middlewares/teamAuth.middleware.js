const jwt = require('jsonwebtoken');
const { TeamMember } = require('../models');

// Third parallel to authenticate (admin) / authenticateUser (user) —
// internal staff accounts (BD/COPS/Account Manager/CSM/QCOPS/Marketing).
// Own JWT `kind:'team_member'` riding on its own `X-Team-Auth` header (same
// idea as the user token's X-User-Auth) so it can never collide with an
// admin session in the same browser.
const authenticateTeamMember = async (req, res, next) => {
  try {
    const header = req.headers['x-team-auth'] || req.headers['X-Team-Auth'] || '';
    const token = String(header).replace(/^Bearer\s+/i, '') || null;
    if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.kind !== 'team_member') {
      return res.status(401).json({ success: false, message: 'Invalid token kind' });
    }

    const member = await TeamMember.findByPk(decoded.id);
    if (!member || !member.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid or inactive account' });
    }

    req.teamMember = member;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// Gate a route behind one specific capability toggle — e.g.
// `requirePermission('canCreateSupplier')`. 403s cleanly if the member's
// admin-assigned permissions don't include it.
const requirePermission = (key) => (req, res, next) => {
  const perms = (req.teamMember && req.teamMember.permissions) || {};
  if (!perms[key]) {
    return res.status(403).json({ success: false, message: 'You do not have access to this feature' });
  }
  next();
};

module.exports = { authenticateTeamMember, requirePermission };

const jwt = require('jsonwebtoken');
const { Admin, TeamMember } = require('../models');

// Lets a route accept EITHER the admin (full access, unaffected — same
// header, same behavior as `authenticate`) OR a permitted team member (BD,
// COPS, ...) via a separate `X-Team-Auth` header, so a team member token
// riding in the same browser never collides with an admin session. Sets
// req.admin OR req.teamMember accordingly — controllers branch on whichever
// is present.
const authenticateStaff = async (req, res, next) => {
  try {
    // Check the specific X-Team-Auth header FIRST. The browser's admin
    // Authorization header can easily still be present (a stale admin
    // session sitting in localStorage) even while acting as a team member
    // in the Team Portal — if Authorization were checked first, a team
    // member's own actions would get silently misattributed to the admin
    // (e.g. a BD-created supplier would show createdByTeamMemberId: null).
    // X-Team-Auth only exists when a request is deliberately made as a team
    // member, so it's the more specific/trustworthy signal here.
    const teamHeader = req.headers['x-team-auth'] || req.headers['X-Team-Auth'];
    const teamToken = teamHeader ? String(teamHeader).replace(/^Bearer\s+/i, '') : null;
    if (teamToken) {
      const decoded = jwt.verify(teamToken, process.env.JWT_SECRET);
      if (decoded.kind === 'team_member') {
        const member = await TeamMember.findByPk(decoded.id);
        if (member && member.isActive) {
          req.teamMember = member;
          return next();
        }
      }
    }

    const adminHeader = req.headers.authorization || '';
    const adminToken = adminHeader.startsWith('Bearer ') ? adminHeader.slice(7) : null;
    if (adminToken) {
      const decoded = jwt.verify(adminToken, process.env.JWT_SECRET);
      if (decoded.kind !== 'team_member') {
        const admin = await Admin.findByPk(decoded.id);
        if (admin && admin.isActive) {
          req.admin = admin;
          return next();
        }
      }
    }

    return res.status(401).json({ success: false, message: 'Not authenticated' });
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// Admin always passes (full access); a team member needs the specific
// capability toggle. Use after authenticateStaff.
const requireStaffPermission = (key) => (req, res, next) => {
  if (req.admin) return next();
  const perms = (req.teamMember && req.teamMember.permissions) || {};
  if (!perms[key]) {
    return res.status(403).json({ success: false, message: 'You do not have access to this feature' });
  }
  next();
};

module.exports = { authenticateStaff, requireStaffPermission };

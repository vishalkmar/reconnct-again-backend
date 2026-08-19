const { verifyAuthToken } = require('../utils/jwt');

/*
  A dedicated Socket.IO namespace (/security) for admin-only real-time security
  alerts (payment fraud). Completely separate from the /review and /support
  namespaces so it can't interfere with any existing real-time flow.

  Only an ADMIN token (kind:'admin', or a legacy admin token with no kind) may
  join — users / suppliers / team members are rejected at the handshake.
*/
const ADMIN_ROOM = 'security:admin';
let nsp = null;

const initSecuritySocket = (io) => {
  if (!io) return null;
  nsp = io.of('/security');

  nsp.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('unauthenticated'));
      const decoded = verifyAuthToken(token);
      // Admin only: a user/supplier/team token declares its own kind → rejected.
      if (decoded.kind && decoded.kind !== 'admin') return next(new Error('forbidden'));
      if (decoded.pwa) return next(new Error('forbidden'));
      socket.admin = { id: decoded.id };
      next();
    } catch {
      next(new Error('invalid token'));
    }
  });

  nsp.on('connection', (socket) => {
    socket.join(ADMIN_ROOM);
  });

  return nsp;
};

// Push a real-time event to every connected admin. No-op if sockets aren't up.
const emitSecurity = (event, payload) => {
  try { if (nsp) nsp.to(ADMIN_ROOM).emit(event, payload); } catch { /* ignore */ }
};

module.exports = { initSecuritySocket, emitSecurity, ADMIN_ROOM };

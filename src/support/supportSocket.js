const jwt = require('jsonwebtoken');
const { SupportConversation, User } = require('../models');
const svc = require('../services/support.service');

// Dedicated Socket.IO namespace for the customer-support chat. Kept separate
// from the PWA socket (which only accepts `pwa` tokens). Accepts ADMIN tokens
// ({id, role}) and USER tokens ({id, kind:'user'}); the `role` handshake hint
// only disambiguates the user vs supplier queue (same account).
//
// Rooms:
//   conv:<id>              — both sides while a thread is open (live messages)
//   support:admin          — every admin socket (inbox list + badge updates)
//   support:party:<userId> — a user's personal room (their unread badge)

let nsp = null;

const partyRoom = (userId) => `support:party:${userId}`;
const convRoom = (id) => `conv:${id}`;

// ── Fan-out helpers (used by REST controller + socket handlers) ──
const emitNewMessage = (conv, message) => {
  if (!nsp) return;
  nsp.to(convRoom(conv.id)).emit('support:message', message);
  nsp.to('support:admin').emit('support:conversation', svc.convJSON(conv));
  if (conv.userId) nsp.to(partyRoom(conv.userId)).emit('support:conversation', svc.convJSON(conv));
};

const emitRead = (conv, by) => {
  if (!nsp) return;
  nsp.to(convRoom(conv.id)).emit('support:read', { conversationId: conv.id, by });
  nsp.to('support:admin').emit('support:conversation', svc.convJSON(conv));
  if (conv.userId) nsp.to(partyRoom(conv.userId)).emit('support:conversation', svc.convJSON(conv));
};

const initSupportSocket = (io) => {
  if (!io) return null;
  nsp = io.of('/support');

  nsp.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      const roleHint = socket.handshake.auth?.role;
      if (!token) return next(new Error('unauthenticated'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (roleHint === 'admin') {
        if (decoded.kind === 'user' || decoded.pwa) return next(new Error('invalid admin token'));
        socket.support = { role: 'admin', id: decoded.id };
      } else {
        if (decoded.kind !== 'user') return next(new Error('invalid user token'));
        socket.support = { role: roleHint === 'supplier' ? 'supplier' : 'user', userId: decoded.id };
      }
      next();
    } catch {
      next(new Error('invalid token'));
    }
  });

  nsp.on('connection', (socket) => {
    const s = socket.support;
    if (s.role === 'admin') socket.join('support:admin');
    else if (s.userId) socket.join(partyRoom(s.userId));

    const canAccess = (conv) => conv && (s.role === 'admin' || conv.userId === s.userId);

    socket.on('support:join', async ({ conversationId } = {}) => {
      try {
        const conv = await SupportConversation.findByPk(Number(conversationId));
        if (!canAccess(conv)) return;
        socket.join(convRoom(conv.id));
        if (s.role === 'admin') { await svc.markReadByAdmin(conv); emitRead(conv, 'admin'); }
        else { await svc.markReadByParty(conv); emitRead(conv, 'party'); }
      } catch { /* ignore */ }
    });

    socket.on('support:leave', ({ conversationId } = {}) => {
      if (conversationId) socket.leave(convRoom(conversationId));
    });

    socket.on('support:message', async (payload = {}, ack) => {
      try {
        const body = String(payload.body || '').slice(0, svc.MAX_BODY).trim();
        const attachments = svc.sanitizeAttachments(payload.attachments);
        if (!body && attachments.length === 0) return ack && ack({ error: 'empty' });

        let conv;
        let msg;
        if (s.role === 'admin') {
          conv = await SupportConversation.findByPk(Number(payload.conversationId));
          if (!conv) return ack && ack({ error: 'not_found' });
          msg = await svc.createMessage({ conv, senderRole: 'admin', senderAdminId: s.id, body, attachments });
        } else {
          const user = await User.findByPk(s.userId);
          if (!user) return ack && ack({ error: 'not_found' });
          conv = await svc.getOrCreateForUser(user, s.role);
          msg = await svc.createMessage({ conv, senderRole: s.role, senderUserId: s.userId, body, attachments });
        }
        socket.join(convRoom(conv.id));
        const out = svc.msgJSON(msg);
        emitNewMessage(conv, { ...out, tempId: payload.tempId });
        ack && ack({ message: out });
      } catch {
        ack && ack({ error: 'failed' });
      }
    });

    socket.on('support:read', async ({ conversationId } = {}) => {
      try {
        const conv = await SupportConversation.findByPk(Number(conversationId));
        if (!canAccess(conv)) return;
        if (s.role === 'admin') { await svc.markReadByAdmin(conv); emitRead(conv, 'admin'); }
        else { await svc.markReadByParty(conv); emitRead(conv, 'party'); }
      } catch { /* ignore */ }
    });

    socket.on('support:typing', ({ conversationId, typing } = {}) => {
      if (!conversationId) return;
      socket.to(convRoom(conversationId)).emit('support:typing', { conversationId, role: s.role, typing: !!typing });
    });
  });

  return nsp;
};

module.exports = { initSupportSocket, emitNewMessage, emitRead };

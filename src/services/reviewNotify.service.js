const jwt = require('jsonwebtoken');
const { ReviewNotification, TeamMember } = require('../models');

/*
  Real-time layer for the experience-review pipeline.

  A dedicated Socket.IO namespace (/review) accepts every party that takes
  part in a review cycle — team members (COPS/BD/QCOPS), hosts (users) and
  suppliers — and drops each into a personal room plus, for COPS/admin, a
  shared `review:cops` room used to live-refresh the queue.

  `notify()` persists a ReviewNotification row AND pushes it to the recipient's
  room, so an offline recipient still finds it in their bell on next load.
*/

let nsp = null;

const COPS_ROOM = 'review:cops';
const roomFor = (type, id) => `review:${type}:${id}`;

const initReviewSocket = (io) => {
  if (!io) return null;
  nsp = io.of('/review');

  nsp.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('unauthenticated'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.pwa) return next(new Error('invalid token'));

      if (decoded.kind === 'team_member') {
        socket.review = { type: 'team', id: decoded.id, roleType: decoded.roleType };
      } else if (decoded.kind === 'user') {
        socket.review = { type: 'user', id: decoded.id };
      } else if (decoded.kind === 'supplier') {
        socket.review = { type: 'supplier', id: decoded.id };
      } else {
        // Admin token (no kind) — treat as a COPS-equivalent overseer.
        socket.review = { type: 'admin', id: decoded.id };
      }
      next();
    } catch {
      next(new Error('invalid token'));
    }
  });

  nsp.on('connection', (socket) => {
    const s = socket.review;
    if (s.type === 'admin') {
      socket.join(COPS_ROOM);
    } else {
      socket.join(roomFor(s.type, s.id));
      // COPS-role team members also watch the shared queue room.
      if (s.type === 'team' && s.roleType === 'cops') socket.join(COPS_ROOM);
    }
  });

  return nsp;
};

const emitTo = (room, event, payload) => {
  if (nsp) nsp.to(room).emit(event, payload);
};

// Persist + push a notification to one recipient.
const notify = async ({ recipientType, recipientId, experienceId = null, kind, title, message = null, meta = null }) => {
  if (!recipientType || !recipientId) return null;
  const row = await ReviewNotification.create({ recipientType, recipientId, experienceId, kind, title, message, meta });
  emitTo(roomFor(recipientType, recipientId), 'review:notification', row.toJSON());
  return row;
};

// Tell every COPS/admin the queue changed (a new/resubmitted item arrived).
const emitQueueChanged = (payload = {}) => emitTo(COPS_ROOM, 'review:queue', payload);

// Which party submitted an experience → who a review event should notify.
const recipientForExperience = (exp) => {
  if (!exp) return null;
  if (exp.createdByTeamMemberId) return { recipientType: 'team', recipientId: exp.createdByTeamMemberId };
  if (exp.ownerUserId) return { recipientType: 'user', recipientId: exp.ownerUserId };
  if (exp.supplierId) return { recipientType: 'supplier', recipientId: exp.supplierId };
  return null;
};

// Notify the submitter of a review event (follow-up / reject / approve).
// When the submitter is a SUPPLIER, also push to their phone so the objection/
// approval reaches them on the lock screen, not just the in-app bell.
const notifySubmitter = async (exp, payload) => {
  const to = recipientForExperience(exp);
  if (!to) return null;
  const row = await notify({ ...to, experienceId: exp.id, ...payload });
  if (to.recipientType === 'supplier') {
    try {
      // eslint-disable-next-line global-require
      const { sendPushToSupplier } = require('./push.service');
      sendPushToSupplier(to.recipientId, {
        title: payload.title || 'Update on your listing',
        body: payload.message || '',
        data: { kind: payload.kind || 'review', experienceId: exp.id },
      }).catch(() => {});
    } catch { /* push optional */ }
  }
  return row;
};

// Notify every active COPS member (bell) + live-refresh the queue — used when
// a fresh or resubmitted item lands in Center Ops.
const notifyCopsTeam = async ({ experienceId = null, kind, title, message = null, meta = null } = {}) => {
  const cops = await TeamMember.findAll({ where: { roleType: 'cops', isActive: true }, attributes: ['id'] });
  await Promise.all(cops.map((c) => notify({
    recipientType: 'team', recipientId: c.id, experienceId, kind, title, message, meta,
  })));
  emitQueueChanged({ experienceId });
};

/*
  Supplier notification that also pushes to their PHONE. A supplier has both a
  web bell (listForSupplier reads the persisted row) and the app (FCM), so an
  important event should reach both — the row for the bell, a push for the
  lock screen.
*/
const notifySupplier = async (supplierId, {
  experienceId = null, kind, title, message = null, meta = null,
} = {}) => {
  if (!supplierId) return null;
  const row = await notify({
    recipientType: 'supplier', recipientId: supplierId, experienceId, kind, title, message, meta,
  });
  try {
    // eslint-disable-next-line global-require
    const { sendPushToSupplier } = require('./push.service');
    sendPushToSupplier(supplierId, { title, body: message || '', data: { kind: kind || 'review', experienceId: experienceId || '' } }).catch(() => {});
  } catch { /* push optional */ }
  return row;
};

module.exports = {
  initReviewSocket, notify, emitQueueChanged, notifySubmitter, notifyCopsTeam, notifySupplier,
  recipientForExperience, COPS_ROOM, roomFor,
};

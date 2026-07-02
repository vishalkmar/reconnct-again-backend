const { Op } = require('sequelize');
const { SupportConversation, SupportMessage } = require('../models');

// Shared support-chat DB logic used by BOTH the REST controller and the socket
// namespace so the two paths stay consistent. This module has no socket
// knowledge (the fan-out lives in support/supportSocket.js).

const MAX_BODY = 4000;
const PAGE = 30;

const cleanQueue = (q) => (q === 'supplier' ? 'supplier' : 'user');

const sanitizeAttachments = (raw) => {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((a) => a && (a.type === 'image' || a.type === 'pdf') && typeof a.url === 'string')
    .slice(0, 10)
    .map((a) => ({ type: a.type, url: a.url, name: String(a.name || '').slice(0, 200), size: Number(a.size) || 0 }));
};

const preview = (body, attachments) => {
  if (body) return body.slice(0, 200);
  if (attachments && attachments.length) return attachments[0].type === 'pdf' ? '📄 PDF' : '📷 Photo';
  return '';
};

const msgJSON = (m) => ({
  id: m.id,
  conversationId: m.conversationId,
  senderRole: m.senderRole,
  senderUserId: m.senderUserId,
  senderAdminId: m.senderAdminId,
  body: m.body || '',
  attachments: Array.isArray(m.attachments) ? m.attachments : [],
  readByAdmin: !!m.readByAdmin,
  readByParty: !!m.readByParty,
  createdAt: m.createdAt,
});

const convJSON = (c) => ({
  id: c.id,
  queue: c.queue,
  userId: c.userId,
  supplierId: c.supplierId,
  subjectLabel: c.subjectLabel,
  subjectEmail: c.subjectEmail,
  subjectPhone: c.subjectPhone,
  lastMessageText: c.lastMessageText,
  lastMessageAt: c.lastMessageAt,
  lastSenderRole: c.lastSenderRole,
  unreadAdmin: c.unreadAdmin,
  unreadParty: c.unreadParty,
  status: c.status,
  updatedAt: c.updatedAt,
});

const getOrCreateForUser = async (user, queue) => {
  const label = user.name || user.email || `User #${user.id}`;
  const email = user.email || null;
  const phone = user.phone || null;
  const [conv] = await SupportConversation.findOrCreate({
    where: { queue, userId: user.id },
    defaults: { queue, userId: user.id, subjectLabel: label, subjectEmail: email, subjectPhone: phone },
  });
  // Keep the denormalised contact details fresh (name/phone can change).
  if (conv.subjectLabel !== label || conv.subjectEmail !== email || conv.subjectPhone !== phone) {
    conv.subjectLabel = label; conv.subjectEmail = email; conv.subjectPhone = phone;
    await conv.save();
  }
  return conv;
};

const markReadByParty = async (conv) => {
  await SupportMessage.update(
    { readByParty: true },
    { where: { conversationId: conv.id, senderRole: 'admin', readByParty: false } },
  );
  if (conv.unreadParty !== 0) { conv.unreadParty = 0; await conv.save(); }
};

const markReadByAdmin = async (conv) => {
  await SupportMessage.update(
    { readByAdmin: true },
    { where: { conversationId: conv.id, senderRole: { [Op.ne]: 'admin' }, readByAdmin: false } },
  );
  if (conv.unreadAdmin !== 0) { conv.unreadAdmin = 0; await conv.save(); }
};

const pageWhere = (conversationId, before) => {
  const where = { conversationId };
  if (before) where.id = { [Op.lt]: Number(before) };
  return where;
};

// Core message create — updates the conversation preview + unread counters.
// senderRole: 'user' | 'supplier' | 'admin'.
const createMessage = async ({ conv, senderRole, senderUserId = null, senderAdminId = null, body, attachments }) => {
  const msg = await SupportMessage.create({
    conversationId: conv.id,
    senderRole,
    senderUserId,
    senderAdminId,
    body,
    attachments,
    readByParty: senderRole !== 'admin',
    readByAdmin: senderRole === 'admin',
  });
  conv.lastMessageText = preview(body, attachments);
  conv.lastMessageAt = msg.createdAt;
  conv.lastSenderRole = senderRole;
  if (senderRole === 'admin') conv.unreadParty = (conv.unreadParty || 0) + 1;
  else conv.unreadAdmin = (conv.unreadAdmin || 0) + 1;
  conv.status = 'open';
  await conv.save();
  return msg;
};

module.exports = {
  MAX_BODY, PAGE, cleanQueue, sanitizeAttachments, preview,
  msgJSON, convJSON, getOrCreateForUser, markReadByParty, markReadByAdmin,
  pageWhere, createMessage,
};

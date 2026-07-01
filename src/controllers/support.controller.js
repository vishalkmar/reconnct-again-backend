const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { SupportConversation, SupportMessage } = require('../models');
const svc = require('../services/support.service');
const { emitNewMessage, emitRead } = require('../support/supportSocket');

/* ═════════════════════════ PARTY (user / host) ═════════════════════════ */

// GET /api/support/me/conversation?queue=user|supplier
exports.meConversation = asyncHandler(async (req, res) => {
  const conv = await svc.getOrCreateForUser(req.user, svc.cleanQueue(req.query.queue));
  const messages = await SupportMessage.findAll({ where: { conversationId: conv.id }, order: [['id', 'DESC']], limit: svc.PAGE });
  await svc.markReadByParty(conv); // opening the thread = reading admin replies
  emitRead(conv, 'party');
  res.json({ success: true, conversation: svc.convJSON(conv), messages: messages.reverse().map(svc.msgJSON) });
});

// GET /api/support/me/messages?conversationId=&before=
exports.meMessages = asyncHandler(async (req, res) => {
  const conv = await SupportConversation.findByPk(Number(req.query.conversationId));
  if (!conv || conv.userId !== req.user.id) return res.status(404).json({ success: false, message: 'Conversation not found' });
  const messages = await SupportMessage.findAll({ where: svc.pageWhere(conv.id, req.query.before), order: [['id', 'DESC']], limit: svc.PAGE });
  res.json({ success: true, messages: messages.reverse().map(svc.msgJSON) });
});

// POST /api/support/me/messages  { queue, body, attachments }
exports.meSend = asyncHandler(async (req, res) => {
  const queue = svc.cleanQueue(req.body.queue);
  const body = String(req.body.body || '').slice(0, svc.MAX_BODY).trim();
  const attachments = svc.sanitizeAttachments(req.body.attachments);
  if (!body && attachments.length === 0) return res.status(400).json({ success: false, message: 'Message is empty' });

  const conv = await svc.getOrCreateForUser(req.user, queue);
  const msg = await svc.createMessage({ conv, senderRole: queue, senderUserId: req.user.id, body, attachments });
  emitNewMessage(conv, svc.msgJSON(msg));
  res.status(201).json({ success: true, message: svc.msgJSON(msg), conversation: svc.convJSON(conv) });
});

// POST /api/support/me/read  { conversationId }
exports.meRead = asyncHandler(async (req, res) => {
  const conv = await SupportConversation.findByPk(Number(req.body.conversationId));
  if (!conv || conv.userId !== req.user.id) return res.status(404).json({ success: false, message: 'Conversation not found' });
  await svc.markReadByParty(conv);
  emitRead(conv, 'party');
  res.json({ success: true });
});

// GET /api/support/me/unread  → { user, supplier }
exports.meUnread = asyncHandler(async (req, res) => {
  const rows = await SupportConversation.findAll({ where: { userId: req.user.id }, attributes: ['queue', 'unreadParty'] });
  const unread = { user: 0, supplier: 0 };
  rows.forEach((r) => { unread[r.queue] = r.unreadParty; });
  res.json({ success: true, unread });
});

/* ═════════════════════════ ADMIN ═════════════════════════ */

// GET /api/support/admin/conversations?queue=&q=
exports.adminConversations = asyncHandler(async (req, res) => {
  const queue = svc.cleanQueue(req.query.queue);
  const q = String(req.query.q || '').trim();
  const where = { queue, lastMessageAt: { [Op.ne]: null } };
  if (q) where.subjectLabel = { [Op.like]: `%${q}%` };
  const conversations = await SupportConversation.findAll({ where, order: [['lastMessageAt', 'DESC']], limit: 200 });
  res.json({ success: true, conversations: conversations.map(svc.convJSON) });
});

// GET /api/support/admin/conversations/:id/messages?before=
exports.adminMessages = asyncHandler(async (req, res) => {
  const conv = await SupportConversation.findByPk(Number(req.params.id));
  if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found' });
  const messages = await SupportMessage.findAll({ where: svc.pageWhere(conv.id, req.query.before), order: [['id', 'DESC']], limit: svc.PAGE });
  if (!req.query.before) { await svc.markReadByAdmin(conv); emitRead(conv, 'admin'); } // initial open = read
  res.json({ success: true, conversation: svc.convJSON(conv), messages: messages.reverse().map(svc.msgJSON) });
});

// POST /api/support/admin/conversations/:id/messages  { body, attachments }
exports.adminReply = asyncHandler(async (req, res) => {
  const conv = await SupportConversation.findByPk(Number(req.params.id));
  if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found' });
  const body = String(req.body.body || '').slice(0, svc.MAX_BODY).trim();
  const attachments = svc.sanitizeAttachments(req.body.attachments);
  if (!body && attachments.length === 0) return res.status(400).json({ success: false, message: 'Reply is empty' });

  const msg = await svc.createMessage({ conv, senderRole: 'admin', senderAdminId: req.admin.id, body, attachments });
  emitNewMessage(conv, svc.msgJSON(msg));
  res.status(201).json({ success: true, message: svc.msgJSON(msg), conversation: svc.convJSON(conv) });
});

// POST /api/support/admin/conversations/:id/read
exports.adminRead = asyncHandler(async (req, res) => {
  const conv = await SupportConversation.findByPk(Number(req.params.id));
  if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found' });
  await svc.markReadByAdmin(conv);
  emitRead(conv, 'admin');
  res.json({ success: true });
});

// GET /api/support/admin/unread  → { user, supplier } (total unread messages)
exports.adminUnread = asyncHandler(async (_req, res) => {
  const rows = await SupportConversation.findAll({ attributes: ['queue', 'unreadAdmin'] });
  const unread = { user: 0, supplier: 0 };
  rows.forEach((r) => { unread[r.queue] += r.unreadAdmin; });
  res.json({ success: true, unread });
});

// PATCH /api/support/admin/conversations/:id  { status }
exports.adminUpdate = asyncHandler(async (req, res) => {
  const conv = await SupportConversation.findByPk(Number(req.params.id));
  if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found' });
  if (['open', 'closed'].includes(req.body.status)) { conv.status = req.body.status; await conv.save(); }
  res.json({ success: true, conversation: svc.convJSON(conv) });
});

const { Op } = require('sequelize');
const {
  Booking, Review, WishlistItem, UserOtpToken,
  SupportConversation, SupportMessage, CampaignDispatch,
  AccountDeletionRequest,
} = require('../models');
const { send } = require('../pwa/services/mailer');
const { emailShell, escapeHtml } = require('../utils/emailLayout');

/*
  Account deletion, as Google Play requires it: the user can REQUEST deletion
  from inside the app, from the member portal, and — without installing anything
  — from a public web page.

  A request does not delete anything by itself. It lands in
  account_deletion_requests, an admin reviews it under Users → Deletion requests,
  and approving it runs deleteUserAccount() below. Deletion is irreversible, so a
  human confirms it and the request row records who did it and when.

  The user ROW is anonymised rather than dropped. Bookings carry a non-null
  userId and are financial records we have to keep, so deleting the row outright
  would either orphan them or take real accounting history with it. Every piece
  of personal data on the row (and on everything that quotes it) is overwritten,
  which is what "deleted" has to mean in practice.
*/

// The deleted row keeps a unique, obviously-dead address so the real one is
// released — a person who deletes their account can sign up again later.
const tombstoneEmail = (id) => `deleted+${id}@deleted.reconnct.app`;

/**
 * Wipe every personal field this user has left across the database.
 * Returns a small summary so the caller can log what actually happened.
 */
const deleteUserAccount = async (user) => {
  const id = user.id;
  const summary = { userId: id, bookings: 0, reviews: 0, wishlist: 0, support: 0 };

  // 1) Bookings stay (accounting), but stop naming a real person.
  const [bookingsUpdated] = await Booking.update(
    { guestName: 'Deleted user', guestEmail: tombstoneEmail(id), guestPhone: '' },
    { where: { userId: id } }
  );
  summary.bookings = bookingsUpdated;

  // 2) Reviews stay visible (they belong to the listing, not the account) but
  //    are detached from the person who wrote them.
  const [reviewsUpdated] = await Review.update(
    { name: 'Deleted user', email: null },
    { where: { userId: id } }
  );
  summary.reviews = reviewsUpdated;

  // 3) Things that are purely this user's and carry no record-keeping value.
  summary.wishlist = await WishlistItem.destroy({ where: { userId: id } });
  await CampaignDispatch.destroy({ where: { userId: id } }).catch(() => {});

  // 4) Support threads — the messages are personal correspondence.
  const conversations = await SupportConversation.findAll({ where: { userId: id }, attributes: ['id'] });
  if (conversations.length) {
    const ids = conversations.map((c) => c.id);
    await SupportMessage.destroy({ where: { conversationId: { [Op.in]: ids } } }).catch(() => {});
    summary.support = await SupportConversation.destroy({ where: { id: { [Op.in]: ids } } });
  }

  // 5) Any live login codes for the old address.
  await UserOtpToken.destroy({ where: { email: user.email } }).catch(() => {});

  // 6) The row itself. isActive:false blocks anything that looks users up by id.
  await user.update({
    email: tombstoneEmail(id),
    name: 'Deleted user',
    phone: null,
    avatarUrl: null,
    gender: null,
    dob: null,
    anniversary: null,
    addressLine: null,
    company: null,
    city: null,
    state: null,
    country: null,
    pincode: null,
    referralCode: null,
    fcmToken: null,
    isProfileComplete: false,
    isActive: false,
    marketingOptOutAt: new Date(),
  });

  console.log(
    '[account-delete] user %s anonymised | bookings=%s reviews=%s wishlist=%s support=%s',
    id, summary.bookings, summary.reviews, summary.wishlist, summary.support
  );
  return summary;
};

/**
 * Record a deletion request. Re-requesting while one is already pending just
 * returns the existing row, so an impatient user can't fill the admin queue.
 */
const createDeletionRequest = async ({ user, source = 'public', reason = null }) => {
  const existing = await AccountDeletionRequest.findOne({
    where: { userId: user.id, status: 'pending' },
  });
  if (existing) return { request: existing, created: false };

  const request = await AccountDeletionRequest.create({
    userId: user.id,
    email: user.email,
    name: user.name || null,
    phone: user.phone || null,
    source,
    reason: reason ? String(reason).slice(0, 500) : null,
  });
  console.log('[account-delete] request #%s raised for user %s via %s', request.id, user.id, source);
  return { request, created: true };
};

/** Receipt so the user knows the request landed and what happens next. */
const sendDeletionRequestedEmail = async ({ user }) => {
  const html = emailShell({
    preheader: 'We received your account deletion request',
    eyebrow: 'Account deletion',
    heading: `We've got your request, ${escapeHtml(user.name || 'there')}`,
    bodyHtml: `
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        You asked us to delete the reconnct account for <strong>${escapeHtml(user.email)}</strong>.
        Our team will review and action it shortly. You'll stay signed in until then, and you can
        keep using the app in the meantime.
      </p>
      <p style="color:#374151;line-height:1.6;margin:0 0 16px;">
        Once it's done, your profile, wishlist and support messages are removed, and your name and
        contact details are stripped from past bookings — the booking records themselves are kept
        for accounting.
      </p>
      <p style="color:#B91C1C;line-height:1.6;font-size:13px;margin:20px 0 0;">
        <strong>Changed your mind, or didn't request this?</strong> Reply to this email and we'll
        cancel the request. Nothing is deleted until we action it.
      </p>
    `,
  });
  const text = [
    `We received your request to delete the reconnct account for ${user.email}.`,
    'Our team will review and action it shortly. Nothing is deleted until then.',
    '',
    "Changed your mind, or didn't request this? Reply to this email and we'll cancel it.",
  ].join('\n');
  return send({ to: user.email, subject: 'We received your account deletion request', html, text });
};

module.exports = {
  deleteUserAccount,
  createDeletionRequest,
  sendDeletionRequestedEmail,
  tombstoneEmail,
};

const router = require('express').Router();

router.use('/auth', require('./auth.routes'));
router.use('/user-auth', require('./userAuth.routes'));
// Public, no-auth surface for the reconnct mobile app (cards / detail / filters).
router.use('/public', require('./public.routes'));
// Admin "App Screens Control" (mobile login/OTP content + media).
router.use('/admin/app-screens', require('./appScreen.routes'));
router.use('/wishlist', require('./wishlist.routes'));
router.use('/notifications', require('./notification.routes'));
router.use('/bookings', require('./booking.routes'));
router.use('/payments', require('./payment.routes'));
router.use('/refer-earn', require('./referEarn.routes'));
router.use('/admin/bookings', require('./adminBooking.routes'));
router.use('/admin/users', require('./adminUser.routes'));
router.use('/admin/notifications', require('./adminNotification.routes'));
router.use('/admin/experience-reviews', require('./adminExperienceReview.routes'));
router.use('/admin/team', require('./adminTeam.routes'));
router.use('/team/auth', require('./teamAuth.routes'));
router.use('/team/review-queue', require('./reviewQueue.routes'));
router.use('/team/review-notifications', require('./reviewNotification.routes'));
router.use('/team/review-stats', require('./reviewStats.routes'));
router.use('/team/qc', require('./qc.routes'));
router.use('/team/my-suppliers', require('./accountManager.routes'));
router.use('/team/my-customers', require('./csm.routes'));
router.use('/admin', require('./adminConfig.routes'));
router.use('/heroes', require('./hero.routes'));
router.use('/header-links', require('./headerLink.routes'));
router.use('/theme', require('./theme.routes'));
router.use('/cities', require('./city.routes'));
router.use('/locations', require('./location.routes'));
router.use('/facilities', require('./facility.routes'));
router.use('/room-views', require('./roomView.routes'));
router.use('/nearby-places', require('./nearbyPlace.routes'));
router.use('/categories', require('./category.routes'));
router.use('/problems', require('./problem.routes'));
router.use('/activities', require('./activity.routes'));
router.use('/areas', require('./area.routes'));
router.use('/cultures', require('./culture.routes'));
router.use('/packages', require('./package.routes'));
router.use('/reviews', require('./review.routes'));
router.use('/trainers', require('./trainer.routes'));
router.use('/checklist', require('./checklistItem.routes'));
router.use('/featured-tabs', require('./featuredTab.routes'));
router.use('/hotels', require('./hotel.routes'));
router.use('/rooms', require('./availableRoom.routes'));
router.use('/add-ons', require('./addOnActivity.routes'));
router.use('/event-activities', require('./eventActivity.routes'));
router.use('/event-types', require('./eventType.routes'));
router.use('/events', require('./event.routes'));
router.use('/promo-banners', require('./promoBanner.routes'));
router.use('/testimonials', require('./testimonial.routes'));
router.use('/blog-categories', require('./blogCategory.routes'));
router.use('/blogs', require('./blog.routes'));
router.use('/uploads', require('./upload.routes'));
router.use('/site-info', require('./siteInfo.routes'));
router.use('/section-themes', require('./sectionTheme.routes'));
router.use('/personalised-recommendation', require('./personalisedRecommendation.routes'));
router.use('/contact', require('./contact.routes'));

// Experiences (Activity / Event builder) + its taxonomy (audiences / broad
// categories / dependent types).
router.use('/experience-taxonomy', require('./experienceTaxonomy.routes'));
router.use('/experiences', require('./experience.routes'));
router.use('/suppliers', require('./supplier.routes'));
router.use('/contracts', require('./contract.routes'));

// Host ("Switch to Host") — a signed-in user creates/manages their own
// experience listings from the app or website. See host.controller.js.
router.use('/host', require('./host.routes'));
router.use('/supplier/auth', require('./supplierAuth.routes'));
router.use('/supplier', require('./supplierPortal.routes'));

// Customer support chat (user + supplier queues → admin). See
// docs/CUSTOMER_SUPPORT_CHAT.md. Socket layer added in Phase 3.
router.use('/support', require('./support.routes'));

// Revenue analytics (admin dashboard).
router.use('/admin/analytics', require('./analytics.routes'));

// PWA — mounted at /api/pwa/* so it stays visibly separate from the
// website API. See backend/src/pwa/routes/index.js for sub-routes.
router.use('/pwa', require('../pwa/routes'));

router.get('/health', (req, res) =>
  res.json({ success: true, message: 'API is healthy', timestamp: new Date().toISOString() })
);

module.exports = router;

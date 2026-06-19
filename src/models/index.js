const { sequelize } = require('../config/database');
const Admin = require('./admin.model');
const Hero = require('./hero.model');
const HeroMedia = require('./heroMedia.model');
const HeaderLink = require('./headerLink.model');
const SiteSetting = require('./siteSetting.model');
const City = require('./city.model');
const Location = require('./location.model');
const Facility = require('./facility.model');
const RoomView = require('./roomView.model');
const NearbyPlace = require('./nearbyPlace.model');
const Category = require('./category.model');
const Problem = require('./problem.model');
const Activity = require('./activity.model');
const Area = require('./area.model');
const Culture = require('./culture.model');
const Package = require('./package.model');
const PackageImage = require('./packageImage.model');
const PackageReview = require('./packageReview.model');
const Review = require('./review.model');
const Trainer = require('./trainer.model');
const ChecklistItem = require('./checklistItem.model');
const FeaturedTab = require('./featuredTab.model');
const Hotel = require('./hotel.model');
const HotelImage = require('./hotelImage.model');
const AvailableRoom = require('./availableRoom.model');
const AvailableRoomImage = require('./availableRoomImage.model');
const AddOnActivity = require('./addOnActivity.model');
const AddOnActivityImage = require('./addOnActivityImage.model');
const EventActivity = require('./eventActivity.model');
const EventType = require('./eventType.model');
const Event = require('./event.model');
const EventImage = require('./eventImage.model');
const EventSlot = require('./eventSlot.model');
const PromoBanner = require('./promoBanner.model');
const PromoBannerSlide = require('./promoBannerSlide.model');
const Testimonial = require('./testimonial.model');
const TestimonialMedia = require('./testimonialMedia.model');
const Blog = require('./blog.model');
const BlogCategory = require('./blogCategory.model');
const BlogScene = require('./blogScene.model');
const User = require('./user.model');
const UserOtpToken = require('./userOtpToken.model');
const WishlistItem = require('./wishlistItem.model');
const Booking = require('./booking.model');
const WalletTransaction = require('./walletTransaction.model');
const Coupon = require('./coupon.model');
const ReferralConfig = require('./referralConfig.model');
const RefundPolicy = require('./refundPolicy.model');
const ExperienceAudience = require('./experienceAudience.model');
const ExperienceCategory = require('./experienceCategory.model');
const ExperienceType = require('./experienceType.model');
const Experience = require('./experience.model');
const Supplier = require('./supplier.model');
const Contract = require('./contract.model');

const db = {
  sequelize,
  Admin,
  Hero,
  HeroMedia,
  HeaderLink,
  SiteSetting,
  City,
  Location,
  Facility,
  RoomView,
  NearbyPlace,
  Category,
  Problem,
  Activity,
  Area,
  Culture,
  Package,
  PackageImage,
  PackageReview,
  Review,
  Trainer,
  ChecklistItem,
  FeaturedTab,
  Hotel,
  HotelImage,
  AvailableRoom,
  AvailableRoomImage,
  AddOnActivity,
  AddOnActivityImage,
  EventActivity,
  EventType,
  Event,
  EventImage,
  EventSlot,
  PromoBanner,
  PromoBannerSlide,
  Testimonial,
  TestimonialMedia,
  Blog,
  BlogCategory,
  BlogScene,
  User,
  UserOtpToken,
  WishlistItem,
  Booking,
  WalletTransaction,
  Coupon,
  ReferralConfig,
  RefundPolicy,
  ExperienceAudience,
  ExperienceCategory,
  ExperienceType,
  Experience,
  Supplier,
  Contract,
};

// ─── Users: self-reference for referrals ──────────────────────────────────
User.belongsTo(User, { foreignKey: 'referredByUserId', as: 'referrer' });
User.hasMany(User, { foreignKey: 'referredByUserId', as: 'referees' });

// ─── Wishlist: belongs to a User, polymorphic to the bookable entity ──────
// We don't add hasMany on Package/Room/Event/AddOnActivity because Sequelize
// can't disambiguate polymorphic FKs cleanly — the wishlist controller does
// the manual hydration instead (matches the Review pattern in this codebase).
User.hasMany(WishlistItem, { foreignKey: 'userId', as: 'wishlistItems', onDelete: 'CASCADE' });
WishlistItem.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// ─── Bookings: belong to a User, polymorphic to the bookable entity ───────
User.hasMany(Booking, { foreignKey: 'userId', as: 'bookings' });
Booking.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// ─── Wallet transactions ──────────────────────────────────────────────────
User.hasMany(WalletTransaction, { foreignKey: 'userId', as: 'walletTransactions', onDelete: 'CASCADE' });
WalletTransaction.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// ─── Coupons (personal coupons belong to a user; public coupons have userId=null) ─
User.hasMany(Coupon, { foreignKey: 'userId', as: 'coupons', onDelete: 'CASCADE' });
Coupon.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Associations
Hero.hasMany(HeroMedia, { foreignKey: 'heroId', as: 'media', onDelete: 'CASCADE' });
HeroMedia.belongsTo(Hero, { foreignKey: 'heroId', as: 'hero' });

// Package <-> City
Package.belongsTo(City, { foreignKey: 'cityId', as: 'city' });
City.hasMany(Package, { foreignKey: 'cityId', as: 'packages' });

// Package <-> Location (FK — shared with Hotels)
Package.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
Location.hasMany(Package, { foreignKey: 'locationId', as: 'packages' });

// Package <-> NearbyPlace (M2M — "nearest things" filter)
Package.belongsToMany(NearbyPlace, {
  through: 'package_nearby_places',
  foreignKey: 'packageId',
  otherKey: 'nearbyPlaceId',
  as: 'nearbyPlaces',
  timestamps: false,
});
NearbyPlace.belongsToMany(Package, {
  through: 'package_nearby_places',
  foreignKey: 'nearbyPlaceId',
  otherKey: 'packageId',
  as: 'packages',
  timestamps: false,
});

// Package <-> Area (M2M)
Package.belongsToMany(Area, {
  through: 'package_areas',
  foreignKey: 'packageId',
  otherKey: 'areaId',
  as: 'areas',
  timestamps: false,
});
Area.belongsToMany(Package, {
  through: 'package_areas',
  foreignKey: 'areaId',
  otherKey: 'packageId',
  as: 'packages',
  timestamps: false,
});

// Package <-> Culture (M2M)
Package.belongsToMany(Culture, {
  through: 'package_cultures',
  foreignKey: 'packageId',
  otherKey: 'cultureId',
  as: 'cultures',
  timestamps: false,
});
Culture.belongsToMany(Package, {
  through: 'package_cultures',
  foreignKey: 'cultureId',
  otherKey: 'packageId',
  as: 'packages',
  timestamps: false,
});

// Package <-> Category (M2M)
Package.belongsToMany(Category, {
  through: 'package_categories',
  foreignKey: 'packageId',
  otherKey: 'categoryId',
  as: 'categories',
  timestamps: false,
});
Category.belongsToMany(Package, {
  through: 'package_categories',
  foreignKey: 'categoryId',
  otherKey: 'packageId',
  as: 'packages',
  timestamps: false,
});

// Package <-> Problem (M2M)
Package.belongsToMany(Problem, {
  through: 'package_problems',
  foreignKey: 'packageId',
  otherKey: 'problemId',
  as: 'problems',
  timestamps: false,
});
Problem.belongsToMany(Package, {
  through: 'package_problems',
  foreignKey: 'problemId',
  otherKey: 'packageId',
  as: 'packages',
  timestamps: false,
});

// Package <-> Activity (M2M)
Package.belongsToMany(Activity, {
  through: 'package_activities',
  foreignKey: 'packageId',
  otherKey: 'activityId',
  as: 'activities',
  timestamps: false,
});
Activity.belongsToMany(Package, {
  through: 'package_activities',
  foreignKey: 'activityId',
  otherKey: 'packageId',
  as: 'packages',
  timestamps: false,
});

// Package <-> PackageImage
Package.hasMany(PackageImage, { foreignKey: 'packageId', as: 'gallery', onDelete: 'CASCADE' });
PackageImage.belongsTo(Package, { foreignKey: 'packageId', as: 'package' });

// Package <-> Trainer (M2M — a trainer can lead many packages, a package
// can have multiple trainers)
Package.belongsToMany(Trainer, {
  through: 'package_trainers',
  foreignKey: 'packageId',
  otherKey: 'trainerId',
  as: 'trainers',
  timestamps: false,
});
Trainer.belongsToMany(Package, {
  through: 'package_trainers',
  foreignKey: 'trainerId',
  otherKey: 'packageId',
  as: 'packages',
  timestamps: false,
});

// Legacy PackageReview association — kept so the one-time migration script in
// scripts/migrateReviews.js can still read from package_reviews. The public &
// admin code paths use the unified `Review` model below instead.
Package.hasMany(PackageReview, { foreignKey: 'packageId', as: 'legacyReviews', onDelete: 'CASCADE' });
PackageReview.belongsTo(Package, { foreignKey: 'packageId', as: 'package' });

// ─── Unified Reviews (polymorphic via entityType + entityId) ──────────────
// Sequelize doesn't natively support polymorphic FKs, so we set `constraints:
// false` and scope each side by entityType. The `reviews` alias on each model
// auto-filters to that entity type, and `Review.entity` is a virtual getter we
// resolve in the controller.
Package.hasMany(Review, {
  foreignKey: 'entityId',
  constraints: false,
  scope: { entityType: 'package' },
  as: 'reviews',
});
Event.hasMany(Review, {
  foreignKey: 'entityId',
  constraints: false,
  scope: { entityType: 'event' },
  as: 'reviews',
});
Hotel.hasMany(Review, {
  foreignKey: 'entityId',
  constraints: false,
  scope: { entityType: 'hotel' },
  as: 'reviews',
});

// Testimonial <-> TestimonialMedia
Testimonial.hasMany(TestimonialMedia, { foreignKey: 'testimonialId', as: 'media', onDelete: 'CASCADE' });
TestimonialMedia.belongsTo(Testimonial, { foreignKey: 'testimonialId', as: 'testimonial' });

// Blog <-> BlogCategory
Blog.belongsTo(BlogCategory, { foreignKey: 'blogCategoryId', as: 'category' });
BlogCategory.hasMany(Blog, { foreignKey: 'blogCategoryId', as: 'blogs' });

// Blog <-> BlogScene
Blog.hasMany(BlogScene, { foreignKey: 'blogId', as: 'scenes', onDelete: 'CASCADE' });
BlogScene.belongsTo(Blog, { foreignKey: 'blogId', as: 'blog' });

// ─── Hotels ───────────────────────────────────────────────────────────────
// Hotel <-> Location (FK)
Hotel.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
Location.hasMany(Hotel, { foreignKey: 'locationId', as: 'hotels' });

// Hotel <-> City (FK — optional, alongside Location)
Hotel.belongsTo(City, { foreignKey: 'cityId', as: 'city' });
City.hasMany(Hotel, { foreignKey: 'cityId', as: 'hotels' });

// Hotel <-> Facility (M2M)
Hotel.belongsToMany(Facility, {
  through: 'hotel_facilities',
  foreignKey: 'hotelId',
  otherKey: 'facilityId',
  as: 'facilities',
  timestamps: false,
});
Facility.belongsToMany(Hotel, {
  through: 'hotel_facilities',
  foreignKey: 'facilityId',
  otherKey: 'hotelId',
  as: 'hotels',
  timestamps: false,
});

// Hotel <-> NearbyPlace (M2M)
Hotel.belongsToMany(NearbyPlace, {
  through: 'hotel_nearby_places',
  foreignKey: 'hotelId',
  otherKey: 'nearbyPlaceId',
  as: 'nearbyPlaces',
  timestamps: false,
});
NearbyPlace.belongsToMany(Hotel, {
  through: 'hotel_nearby_places',
  foreignKey: 'nearbyPlaceId',
  otherKey: 'hotelId',
  as: 'hotels',
  timestamps: false,
});

// Hotel <-> HotelImage (gallery)
Hotel.hasMany(HotelImage, { foreignKey: 'hotelId', as: 'gallery', onDelete: 'CASCADE' });
HotelImage.belongsTo(Hotel, { foreignKey: 'hotelId', as: 'hotel' });

// ─── Available Rooms ──────────────────────────────────────────────────────
// Hotel <-> AvailableRoom (FK — one hotel has many rooms)
Hotel.hasMany(AvailableRoom, { foreignKey: 'hotelId', as: 'rooms', onDelete: 'CASCADE' });
AvailableRoom.belongsTo(Hotel, { foreignKey: 'hotelId', as: 'hotel' });

// Package <-> AvailableRoom (FK — a room can instead belong to a package)
Package.hasMany(AvailableRoom, { foreignKey: 'packageId', as: 'rooms', onDelete: 'CASCADE' });
AvailableRoom.belongsTo(Package, { foreignKey: 'packageId', as: 'package' });

// AvailableRoom <-> Facility (M2M)
AvailableRoom.belongsToMany(Facility, {
  through: 'room_facilities',
  foreignKey: 'roomId',
  otherKey: 'facilityId',
  as: 'facilities',
  timestamps: false,
});
Facility.belongsToMany(AvailableRoom, {
  through: 'room_facilities',
  foreignKey: 'facilityId',
  otherKey: 'roomId',
  as: 'rooms',
  timestamps: false,
});

// AvailableRoom <-> RoomView (M2M — a room can have multiple views)
AvailableRoom.belongsToMany(RoomView, {
  through: 'room_views_pivot',
  foreignKey: 'roomId',
  otherKey: 'roomViewId',
  as: 'views',
  timestamps: false,
});
RoomView.belongsToMany(AvailableRoom, {
  through: 'room_views_pivot',
  foreignKey: 'roomViewId',
  otherKey: 'roomId',
  as: 'rooms',
  timestamps: false,
});

// AvailableRoom <-> AvailableRoomImage (gallery)
AvailableRoom.hasMany(AvailableRoomImage, { foreignKey: 'roomId', as: 'gallery', onDelete: 'CASCADE' });
AvailableRoomImage.belongsTo(AvailableRoom, { foreignKey: 'roomId', as: 'room' });

// ─── Add-on Activities ────────────────────────────────────────────────────
// AddOnActivity <-> Location
AddOnActivity.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
Location.hasMany(AddOnActivity, { foreignKey: 'locationId', as: 'addOnActivities' });

// AddOnActivity <-> Hotel / Package (optional owner — else "general")
Hotel.hasMany(AddOnActivity, { foreignKey: 'hotelId', as: 'addOnActivities', onDelete: 'SET NULL' });
AddOnActivity.belongsTo(Hotel, { foreignKey: 'hotelId', as: 'hotel' });
Package.hasMany(AddOnActivity, { foreignKey: 'packageId', as: 'addOnActivities', onDelete: 'SET NULL' });
AddOnActivity.belongsTo(Package, { foreignKey: 'packageId', as: 'package' });

// AddOnActivity <-> AddOnActivityImage (gallery)
AddOnActivity.hasMany(AddOnActivityImage, { foreignKey: 'activityId', as: 'gallery', onDelete: 'CASCADE' });
AddOnActivityImage.belongsTo(AddOnActivity, { foreignKey: 'activityId', as: 'activity' });

// ─── Events ───────────────────────────────────────────────────────────────
// Event <-> EventType (FK)
Event.belongsTo(EventType, { foreignKey: 'eventTypeId', as: 'eventType' });
EventType.hasMany(Event, { foreignKey: 'eventTypeId', as: 'events' });

// Event <-> Location (FK)
Event.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
Location.hasMany(Event, { foreignKey: 'locationId', as: 'events' });

// Event <-> EventImage (gallery)
Event.hasMany(EventImage, { foreignKey: 'eventId', as: 'gallery', onDelete: 'CASCADE' });
EventImage.belongsTo(Event, { foreignKey: 'eventId', as: 'event' });

// Event <-> EventSlot (slots — only relevant for sport-type events)
Event.hasMany(EventSlot, { foreignKey: 'eventId', as: 'slots', onDelete: 'CASCADE' });
EventSlot.belongsTo(Event, { foreignKey: 'eventId', as: 'event' });

// ─── Promo Banners ────────────────────────────────────────────────────────
PromoBanner.hasMany(PromoBannerSlide, {
  foreignKey: 'bannerId',
  as: 'slides',
  onDelete: 'CASCADE',
});
PromoBannerSlide.belongsTo(PromoBanner, { foreignKey: 'bannerId', as: 'banner' });

// ─── Experiences (Activity / Event builder) ───────────────────────────────
// Broad category → many types (the chart's sub-items).
ExperienceCategory.hasMany(ExperienceType, { foreignKey: 'categoryId', as: 'types', onDelete: 'CASCADE' });
ExperienceType.belongsTo(ExperienceCategory, { foreignKey: 'categoryId', as: 'category' });

// An Experience picks one broad category + one type. Audiences are stored as a
// JSON id-array on the row (multi-select, hydrated in the controller).
Experience.belongsTo(ExperienceCategory, { foreignKey: 'categoryId', as: 'category' });
ExperienceCategory.hasMany(Experience, { foreignKey: 'categoryId', as: 'experiences' });
Experience.belongsTo(ExperienceType, { foreignKey: 'typeId', as: 'type' });
ExperienceType.hasMany(Experience, { foreignKey: 'typeId', as: 'experiences' });

// An Experience optionally belongs to one Supplier; a supplier runs many.
Experience.belongsTo(Supplier, { foreignKey: 'supplierId', as: 'supplier' });
Supplier.hasMany(Experience, { foreignKey: 'supplierId', as: 'experiences', onDelete: 'SET NULL' });

// Contracts belong to a Supplier (one supplier → many contracts).
Contract.belongsTo(Supplier, { foreignKey: 'supplierId', as: 'supplier' });
Supplier.hasMany(Contract, { foreignKey: 'supplierId', as: 'contracts', onDelete: 'CASCADE' });

// PWA models register themselves with sequelize on require. We pull them in
// here so a single `require('./models')` from app/server boots both worlds.
// They live under separate `pwa_*` tables and never join with website tables.
const pwaModels = require('../pwa/models');
Object.assign(db, { pwa: pwaModels });

module.exports = db;

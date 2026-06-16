const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Package = sequelize.define(
  'Package',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Basic
    name: { type: DataTypes.STRING(220), allowNull: false },
    slug: { type: DataTypes.STRING(240), allowNull: false },
    shortDescription: { type: DataTypes.TEXT('long'), allowNull: true },
    description: { type: DataTypes.TEXT('long'), allowNull: true },

    // Media
    primaryImage: { type: DataTypes.STRING(500), allowNull: true },
    videoUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'Optional URL of overview video (YouTube/Vimeo/MP4)',
    },

    // Location
    cityId: { type: DataTypes.INTEGER, allowNull: true },
    // Free-text city typed manually next to the state. Preferred over cityId.
    cityName: { type: DataTypes.STRING(160), allowNull: true },
    locationId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'FK to Location taxonomy (shared with Hotels)',
    },
    locationDetail: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Free text like "Kochi, Kerala, India"',
    },

    // Time
    durationDays: { type: DataTypes.INTEGER, defaultValue: 1 },
    durationNights: { type: DataTypes.INTEGER, defaultValue: 0 },
    timing: {
      type: DataTypes.STRING(160),
      allowNull: true,
      comment: 'e.g. "Available all year round" or "Daily 07:00 - 21:00"',
    },
    availableAllYear: { type: DataTypes.BOOLEAN, defaultValue: true },
    startDate: { type: DataTypes.DATEONLY, allowNull: true },
    endDate: { type: DataTypes.DATEONLY, allowNull: true },

    // Group
    minGroupSize: { type: DataTypes.INTEGER, defaultValue: 1 },
    maxGroupSize: { type: DataTypes.INTEGER, defaultValue: 30 },

    // Pricing
    priceFrom: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    priceOriginal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Strike-through price for discount display',
    },
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },
    // GST percent added to the price at checkout (0 = Off). One of 0/5/18/28/40.
    gstRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // TCS percent applied on price + GST (0 = Off).
    tcsRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // How the price is charged + the public unit label. See config/priceType.js.
    priceType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'per_person' },
    priceLabel: { type: DataTypes.STRING(60), allowNull: true },

    // Stats
    rating: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0 },
    reviewCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    interestedCount: { type: DataTypes.INTEGER, defaultValue: 0 },

    // Badges / flags
    freeCancellation: { type: DataTypes.BOOLEAN, defaultValue: true },

    // Cancellation / refund — when false, cancelling never refunds money even
    // if the cutoff would have qualified. When true, the platform's global
    // RefundPolicy applies unless `refundPolicyOverride` is set.
    isRefundable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    refundPolicyOverride: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Per-item refund tiers — same shape as RefundPolicy.tiers. When null the global policy is used.',
    },

    isGoldHost: { type: DataTypes.BOOLEAN, defaultValue: false },
    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    isPopular: { type: DataTypes.BOOLEAN, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },

    // Single rich-text block that previously combined highlights/inclusions/
    // exclusions. Kept for backward compatibility but no longer surfaced in
    // the admin form — replaced by three separate rich-text fields below.
    richContent: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'Legacy combined HTML for highlights/included/excluded',
    },

    // Three independent rich-text blocks for the public detail page.
    highlightsRich: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'HTML — Highlights of the retreat',
    },
    inclusionsRich: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'HTML — What is included',
    },
    exclusionsRich: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'HTML — What is not included',
    },

    // Additional rich-text policy / experience blocks
    termsConditions: { type: DataTypes.TEXT('long'), allowNull: true },
    refundsPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    cancellationPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    bookingTerms: { type: DataTypes.TEXT('long'), allowNull: true },
    retreatExperience: { type: DataTypes.TEXT('long'), allowNull: true },
    whatMakesSpecial: { type: DataTypes.TEXT('long'), allowNull: true },
    fullProgramTiming: { type: DataTypes.TEXT('long'), allowNull: true },

    // Food (rich text HTML) + structured meals / diets pickers
    food: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'HTML content describing the food / cuisine',
    },
    meals: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of meal types served, e.g. ["Breakfast","Lunch","Dinner"]',
    },
    diets: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of diets catered, e.g. ["Vegan","Gluten Free"]',
    },

    // Benefits — rich text HTML
    benefits: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      comment: 'HTML content describing benefits guests can expect',
    },

    // Facilities offered at the venue
    facilities: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of facilities, e.g. ["Free Wifi","Pool","Spa"]',
    },

    // Legacy structured lists — kept for backwards compatibility but no longer
    // surfaced in the admin form (the rich-text editor replaces them).
    highlights: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Legacy: array of highlight strings',
    },
    includes: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Legacy: array of "what is included" strings',
    },
    excludes: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Legacy: array of "what is not included" strings',
    },
    itinerary: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of { day, title, description }',
    },
    faqs: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of { question, answer }',
    },

    // Admin-added "additional fields" from the PWA→website listing config,
    // rendered as their own titled blocks on the public detail page.
    // Shape: [{ name, type:'text'|'image', value }].
    extraSections: { type: DataTypes.JSON, defaultValue: [] },

    // Host
    hostName: { type: DataTypes.STRING(160), allowNull: true },
    hostBio: { type: DataTypes.TEXT, allowNull: true },
    hostImage: { type: DataTypes.STRING(500), allowNull: true },

    // Owner & Salesperson assignment — used by the Check-Availability flow.
    // pwaOwnerId: FK to pwa_property_owners (the person who confirms / denies
    // the booking date in the PWA owner dashboard). pwaSalespersonId: FK to
    // pwa_salespersons (the inside-sales rep who works the lead). Both are
    // nullable so existing packages without an assignment still work.
    pwaOwnerId:       { type: DataTypes.INTEGER, allowNull: true },
    pwaSalespersonId: { type: DataTypes.INTEGER, allowNull: true },

    // Direct contact details for the owner (used to fire the dummy voice
    // call). Mirror of PropertyOwner.email/phone so we don't have to JOIN on
    // every lead submission.
    ownerContactName:  { type: DataTypes.STRING(160), allowNull: true },
    ownerContactEmail: { type: DataTypes.STRING(180), allowNull: true },
    ownerContactPhone: { type: DataTypes.STRING(30),  allowNull: true },

    // SEO
    metaTitle: { type: DataTypes.STRING(255), allowNull: true },
    metaDescription: { type: DataTypes.STRING(500), allowNull: true },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'packages',
    indexes: [
      { name: 'packages_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['cityId'] },
      { fields: ['locationId'] },
      { fields: ['isActive'] },
      { fields: ['isFeatured'] },
      { fields: ['isPopular'] },
      { fields: ['priceFrom'] },
    ],
  }
);

module.exports = Package;

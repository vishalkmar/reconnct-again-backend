const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Events & Activity — a category-driven listing. The admin picks one of 12
  categories and the form shows that category's fields. Common fields are real
  columns; the per-category fields (which vary wildly and can be huge) live in
  the schema-less `categoryData` JSON so the form can grow without migrations.
  Media are instant-upload URLs (no separate image table). See
  docs/events-activity-platform.md for the full spec.
*/
const EVENT_CATEGORIES = [
  'birthday', 'anniversary', 'group', 'music', 'wellness', 'spiritual',
  'diy', 'arts_crafts', 'poetry', 'fun', 'theatre', 'comedy',
];

const EventActivity = sequelize.define(
  'EventActivity',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Basic
    title: { type: DataTypes.STRING(240), allowNull: false },
    subtitle: { type: DataTypes.STRING(300), allowNull: true },
    slug: { type: DataTypes.STRING(260), allowNull: false },
    category: { type: DataTypes.ENUM(...EVENT_CATEGORIES), allowNull: false },
    subCategory: { type: DataTypes.STRING(160), allowNull: true },
    activityType: { type: DataTypes.ENUM('online', 'offline', 'hybrid'), defaultValue: 'offline' },
    status: { type: DataTypes.ENUM('draft', 'published', 'archived'), defaultValue: 'draft' },
    // "Who is it for?" — always-visible audience filter (partners/friends/…)
    audience: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // Media (instant-upload URLs)
    mainBanner: { type: DataTypes.STRING(500), allowNull: true },
    mobileBanner: { type: DataTypes.STRING(500), allowNull: true },
    thumbnail: { type: DataTypes.STRING(500), allowNull: true },
    youtubeUrl: { type: DataTypes.STRING(500), allowNull: true },
    gallery: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    promoVideos: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // Location
    venueName: { type: DataTypes.STRING(220), allowNull: true },
    venueAddress: { type: DataTypes.TEXT, allowNull: true },
    landmark: { type: DataTypes.STRING(220), allowNull: true },
    city: { type: DataTypes.STRING(160), allowNull: true },
    state: { type: DataTypes.STRING(160), allowNull: true },
    country: { type: DataTypes.STRING(120), allowNull: true, defaultValue: 'India' },
    pincode: { type: DataTypes.STRING(20), allowNull: true },
    mapEmbed: { type: DataTypes.TEXT('long'), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },

    // Date & timing
    startDate: { type: DataTypes.DATEONLY, allowNull: true },
    endDate: { type: DataTypes.DATEONLY, allowNull: true },
    startTime: { type: DataTypes.STRING(8), allowNull: true },
    endTime: { type: DataTypes.STRING(8), allowNull: true },
    duration: { type: DataTypes.STRING(120), allowNull: true },

    // Capacity
    totalSeats: { type: DataTypes.INTEGER, allowNull: true },
    availableSeats: { type: DataTypes.INTEGER, allowNull: true },
    minParticipants: { type: DataTypes.INTEGER, allowNull: true },
    maxParticipants: { type: DataTypes.INTEGER, allowNull: true },

    // Pricing (base — detailed tickets in JSON below)
    isPaid: { type: DataTypes.BOOLEAN, defaultValue: true },
    adultPrice: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    childPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    couplePrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    groupPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },
    // GST percent added to every price/ticket at checkout (0 = Off). One of
    // 0/5/18/28/40 — applies globally to this activity's pricing.
    gstRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Description
    shortDescription: { type: DataTypes.TEXT, allowNull: true },
    longDescription: { type: DataTypes.TEXT('long'), allowNull: true },
    highlights: { type: DataTypes.TEXT('long'), allowNull: true },
    whatMakesSpecial: { type: DataTypes.TEXT('long'), allowNull: true },
    inclusions: { type: DataTypes.TEXT('long'), allowNull: true },
    exclusions: { type: DataTypes.TEXT('long'), allowNull: true },
    faqs: { type: DataTypes.JSON, defaultValue: [] },

    // Policies — common to every category.
    refundPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    cancellationPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    termsConditions: { type: DataTypes.TEXT('long'), allowNull: true },

    // Availability & scheduling (the "Quick Details" block):
    //   { mode:'fixed_slots'|'hourly'|'range',
    //     availability:[{ dayGroup, customDays:[], times:[] }],
    //     durationMin, durationMax,
    //     windowStart, windowEnd, minHours, maxHours,
    //     travelTime, pickupDrop, pickupDropNote }
    schedule: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },

    // Host
    hostName: { type: DataTypes.STRING(200), allowNull: true },
    hostBio: { type: DataTypes.TEXT, allowNull: true },
    hostImage: { type: DataTypes.STRING(500), allowNull: true },
    hostInstagram: { type: DataTypes.STRING(300), allowNull: true },
    hostFacebook: { type: DataTypes.STRING(300), allowNull: true },
    hostWebsite: { type: DataTypes.STRING(300), allowNull: true },

    // SEO
    metaTitle: { type: DataTypes.STRING(300), allowNull: true },
    metaDescription: { type: DataTypes.TEXT, allowNull: true },
    metaKeywords: { type: DataTypes.JSON, defaultValue: [] },

    // Reviews
    rating: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0 },
    testimonials: { type: DataTypes.JSON, defaultValue: [] },
    userImages: { type: DataTypes.JSON, defaultValue: [] },

    // Dynamic builders
    tickets: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    addons: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },

    // THE category-specific fields (schema-less)
    categoryData: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },

    // Flags
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'event_activities',
    indexes: [
      { name: 'event_activities_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['category'] },
      { fields: ['status'] },
      { fields: ['isActive'] },
    ],
  }
);

EventActivity.CATEGORIES = EVENT_CATEGORIES;
module.exports = EventActivity;

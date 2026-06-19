const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Experience — the unified Activity / Event record built from the admin form.
  Structure mirrors the Reconnct chart + the form spec:
    - audiences  : JSON array of ExperienceAudience ids (multi-select)
    - categoryId : the single broad ExperienceCategory
    - typeId     : the ExperienceType under that category
  Concrete, known fields are real columns; the still-evolving / large blocks
  (dynamic pricing, schedule calendar, inclusions, faqs, …) are JSON so the form
  can keep growing task-by-task WITHOUT a migration each time.
*/
const Experience = sequelize.define(
  'Experience',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // ── Taxonomy (Task 1) ────────────────────────────────────────────────
    name: { type: DataTypes.STRING(240), allowNull: false },
    slug: { type: DataTypes.STRING(260), allowNull: false },
    audiences: { type: DataTypes.JSON, allowNull: false, defaultValue: [] }, // [audienceId,…]
    categoryId: { type: DataTypes.INTEGER, allowNull: true },
    typeId: { type: DataTypes.INTEGER, allowNull: true },
    // Optional owning supplier (admin "Suppliers" tab).
    supplierId: { type: DataTypes.INTEGER, allowNull: true },

    // ── Core details (Task 4) ────────────────────────────────────────────
    location: { type: DataTypes.STRING(255), allowNull: true },
    city: { type: DataTypes.STRING(160), allowNull: true },
    nearbyLocation: { type: DataTypes.STRING(255), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    rating: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0 },
    about: { type: DataTypes.TEXT('long'), allowNull: true },

    // Media — instant-upload URLs (no separate image table)
    mainImage: { type: DataTypes.STRING(500), allowNull: true },
    gallery: { type: DataTypes.JSON, allowNull: false, defaultValue: [] }, // [url,…]
    videos: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },  // [{type,url}]

    mode: { type: DataTypes.ENUM('online', 'offline', 'hybrid'), defaultValue: 'offline' },
    status: { type: DataTypes.ENUM('draft', 'published', 'archived'), defaultValue: 'draft' },

    // ── Pricing (Task 4 #9) ──────────────────────────────────────────────
    // priceMethod: per_person | per_day | days | per_hours
    priceMethod: { type: DataTypes.STRING(30), allowNull: true },
    // The whole dynamic pricing config (adult/children age-bands, duration…).
    pricing: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    currency: { type: DataTypes.STRING(8), defaultValue: 'INR' },

    // ── Tax & discount (GST task) ────────────────────────────────────────
    gstRate: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // 0/5/12/18/28
    discount: { type: DataTypes.JSON, allowNull: true }, // { type:'percentage'|'fixed', value }
    // Convenience fee — applied on the FINAL amount (net + GST), after discount.
    // { type:'free'|'fixed'|'percentage', value, months, cutThrough }
    convenienceFee: { type: DataTypes.JSON, allowNull: true },

    // ── Rich-text blocks & repeaters ─────────────────────────────────────
    termsConditions: { type: DataTypes.TEXT('long'), allowNull: true },
    privacyPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    // Single merged block (the form's "Refund & Cancellation Policy").
    refundCancellationPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    // Deprecated — kept so existing data isn't dropped by sync({ alter }); the
    // form/view fall back to these when refundCancellationPolicy is empty.
    refundPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    cancellationPolicy: { type: DataTypes.TEXT('long'), allowNull: true },
    inclusions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] }, // [{kind,title,image,text}]
    faqs: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },        // [{question,answer}]
    facilities: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },  // [facility name/obj]
    nearbyPlaces: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },// [{name,distanceKm}]

    // ── Availability & scheduling (calendar + slots task) ────────────────
    schedule: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },

    // Catch-all for anything not yet promoted to a column.
    data: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },

    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'experiences',
    indexes: [
      { name: 'experiences_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['categoryId'] },
      { fields: ['typeId'] },
      { fields: ['status'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = Experience;

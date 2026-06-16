const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Testimonial types — what content the card carries:
   - text       : author quote (stars + content + avatar)
   - image      : a single hero image + optional quote
   - gallery    : multiple images
   - video      : a single video (URL or uploaded) + optional poster
   - image_text : image + quote/text together (split card)
   - video_text : video + quote/text together (split card)
   - image_video: mixed media — both shown
*/
const TYPES = ['text', 'image', 'gallery', 'video', 'image_text', 'video_text', 'image_video'];

// How a single testimonial card is displayed when rendered in a section
const DISPLAY_MODES = ['carousel', 'grid'];

// Where on the public site this testimonial appears. A single testimonial
// can be placed in multiple spots (multi-select in admin), so this is stored
// as a JSON array of placement keys.
const PLACEMENTS = [
  { value: 'home_clients_say', label: 'Home — "What our clients say" (arc carousel)' },
  { value: 'home_video_band',  label: 'Home — Video testimonials band' },
  { value: 'home_grid',        label: 'Home — Static testimonial grid' },
  { value: 'about_page',       label: 'About page' },
  { value: 'package_detail',   label: 'Package detail page' },
  { value: 'retreats_page',    label: 'Retreats listing page' },
  { value: 'blogs_page',       label: 'Blogs page' },
  { value: 'contact_page',     label: 'Contact page' },
];

const Testimonial = sequelize.define(
  'Testimonial',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    type: { type: DataTypes.ENUM(...TYPES), allowNull: false, defaultValue: 'text' },

    // Author
    authorName: { type: DataTypes.STRING(120), allowNull: true },
    authorTitle: { type: DataTypes.STRING(160), allowNull: true },
    authorLocation: { type: DataTypes.STRING(160), allowNull: true },
    authorAvatar: { type: DataTypes.STRING(500), allowNull: true },

    // Quote / rating (text + image + video)
    rating: { type: DataTypes.INTEGER, allowNull: true },
    content: { type: DataTypes.TEXT, allowNull: true },

    // Video specific
    videoUrl: { type: DataTypes.STRING(500), allowNull: true },
    videoPoster: { type: DataTypes.STRING(500), allowNull: true },

    // Display
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },

    // Per-card layout config — admin can pin a custom width/height in pixels.
    // Leaving null lets the section use its responsive defaults.
    cardWidth: { type: DataTypes.INTEGER, allowNull: true, comment: 'Custom width px' },
    cardHeight: { type: DataTypes.INTEGER, allowNull: true, comment: 'Custom height px' },

    // Section-level display mode this testimonial wants when rendered
    displayMode: {
      type: DataTypes.ENUM(...DISPLAY_MODES),
      defaultValue: 'carousel',
    },

    // Per-card padding / margin (px) — overrides the section defaults so
    // admin can fine-tune spacing without touching CSS.
    cardPadding: { type: DataTypes.INTEGER, allowNull: true, comment: 'Custom padding px' },
    cardMargin:  { type: DataTypes.INTEGER, allowNull: true, comment: 'Custom margin px' },

    // Where this testimonial appears — JSON array of placement keys.
    // Empty array means "use legacy defaults" (video shows in video band,
    // others in clients-say arc).
    placements: {
      type: DataTypes.JSON,
      defaultValue: [],
      comment: 'Array of placement keys this testimonial should appear in',
    },
  },
  {
    tableName: 'testimonials',
    indexes: [
      { fields: ['type'] },
      { fields: ['isActive'] },
      { fields: ['displayMode'] },
    ],
  }
);

Testimonial.TYPES = TYPES;
Testimonial.DISPLAY_MODES = DISPLAY_MODES;
Testimonial.PLACEMENTS = PLACEMENTS;
module.exports = Testimonial;

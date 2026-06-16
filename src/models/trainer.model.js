const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Trainer profile — a coach / instructor / wellness practitioner who can be
// attached to one or more packages via the `package_trainers` join table.
// Lives next to AvailableRoom and AddOnActivity as a "package configuration"
// module in the admin nav.
const Trainer = sequelize.define(
  'Trainer',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },

    // Headline role — e.g. "Yoga Teacher", "Naturopath", "Pranic Healer"
    role: { type: DataTypes.STRING(160), allowNull: true },

    // Years of professional experience (display-only, optional)
    experienceYears: { type: DataTypes.INTEGER, allowNull: true },

    // Specialties — JSON array of free-form tags ("Hatha", "Vinyasa", "Meditation")
    specialties: { type: DataTypes.JSON, defaultValue: [] },

    // Spoken languages — JSON array (["English", "Hindi"])
    languages: { type: DataTypes.JSON, defaultValue: [] },

    // Certifications — JSON array of {title, issuer}
    certifications: { type: DataTypes.JSON, defaultValue: [] },

    // Optional social profiles — JSON {instagram, website, linkedin, youtube}
    socials: { type: DataTypes.JSON, defaultValue: {} },

    // Media
    photo: { type: DataTypes.STRING(500), allowNull: true },

    // Rich-text bio
    bioRich: { type: DataTypes.TEXT('long'), allowNull: true },

    // Quick one-liner — shown on cards / package detail mini-card
    shortBio: { type: DataTypes.STRING(280), allowNull: true },

    isFeatured: { type: DataTypes.BOOLEAN, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'trainers',
    indexes: [
      { name: 'trainers_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
      { fields: ['isFeatured'] },
    ],
  }
);

module.exports = Trainer;

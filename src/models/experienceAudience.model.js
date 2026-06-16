const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/*
  Experience Audience — the "Experiences for every you" tags from the Reconnct
  chart (Self, Partner, Family, Friends, Kids & Teens, Elders, Corporate, …).
  An experience can carry MANY audiences (multi-select). Admins can add custom
  audiences on the fly; they persist here so they're reusable next time.
*/
const ExperienceAudience = sequelize.define(
  'ExperienceAudience',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    icon: { type: DataTypes.STRING(40), allowNull: true, comment: 'Optional emoji / icon key' },
    // Custom = added inline by an admin (vs the seeded defaults). Purely for UI.
    isCustom: { type: DataTypes.BOOLEAN, defaultValue: false },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'experience_audiences',
    indexes: [
      { name: 'experience_audiences_slug_unique', unique: true, fields: ['slug'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = ExperienceAudience;

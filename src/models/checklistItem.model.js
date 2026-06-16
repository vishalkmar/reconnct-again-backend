const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Audit-checklist item shown on the homepage between the hero and the
// "Featured Retreats" carousel. Admin can edit the 20 stock items (or add new
// ones) — each item has an icon (lucide name OR uploaded image), a label, and
// a tooltip body shown on hover.
const ChecklistItem = sequelize.define(
  'ChecklistItem',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Short label rendered on the chip — e.g. "Practitioner credentials"
    label: { type: DataTypes.STRING(120), allowNull: false },

    // Tooltip body shown on hover. Plain text — wraps to multiple lines.
    description: { type: DataTypes.TEXT, allowNull: true },

    // Icon — admin can either pick a lucide-react icon name (string we map to
    // a component on the client), or upload an image which lives at iconUrl.
    // If both are set, iconUrl wins. If neither, the client falls back to a
    // generic "ShieldCheck".
    iconName: { type: DataTypes.STRING(80), allowNull: true },
    iconUrl: { type: DataTypes.STRING(500), allowNull: true },

    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  {
    tableName: 'checklist_items',
    indexes: [{ fields: ['isActive'] }, { fields: ['sortOrder'] }],
  }
);

module.exports = ChecklistItem;

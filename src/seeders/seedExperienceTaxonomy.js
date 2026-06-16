/**
 * Seed the Experience taxonomy straight from the Reconnct chart:
 *   - 8 audiences ("Experiences for every you")
 *   - 9 broad categories + their types ("Experience Categories")
 *
 * Idempotent — re-running only inserts what's missing (matched by slug). It
 * never overwrites admin edits or deletes custom rows.
 *
 *   npm run seed:experience
 */
require('dotenv').config();
const slugify = require('slugify');
const {
  sequelize, ExperienceAudience, ExperienceCategory, ExperienceType,
} = require('../models');

const slug = (s) => slugify(String(s), { lower: true, strict: true });

const AUDIENCES = [
  { name: 'Self', icon: '🧘', description: 'Reconnect with yourself' },
  { name: 'Partner', icon: '💞', description: 'Reconnect with your partner' },
  { name: 'Kids & Teens', icon: '🧒', description: 'Inspire, learn and grow' },
  { name: 'Family', icon: '👨‍👩‍👧', description: 'Create moments together' },
  { name: 'Friends', icon: '🧑‍🤝‍🧑', description: 'Make memories, strengthen bonds' },
  { name: 'Community & New Connections', icon: '👥', description: 'Meet like-minded people' },
  { name: 'Elders & Active Seniors', icon: '🧓', description: 'Engage, explore and enjoy' },
  { name: 'Corporate & Teams', icon: '💼', description: 'Build stronger teams' },
];

const CATEGORIES = [
  { name: 'Wellness & Well-being', icon: '🌿', types: ['Retreats', 'Yoga & Meditation', 'Ayurveda', 'Healing Therapies', 'Mindfulness', 'Digital Detox'] },
  { name: 'Adventure & Outdoors', icon: '⛰️', types: ['Trekking', 'Camping', 'Water Activities', 'Wildlife Experiences', 'Nature Escapes', 'Adventure Sports'] },
  { name: 'Learning & Growth', icon: '📖', types: ['Workshops', 'Skill Development', 'Leadership Programs', 'Personal Growth', 'Language Learning', 'Educational Tours'] },
  { name: 'Arts & Creativity', icon: '🎨', types: ['Music', 'Dance', 'Painting', 'Photography', 'Creative Workshops', 'Theatre & Drama'] },
  { name: 'Food & Culture', icon: '🍽️', types: ['Culinary Experiences', 'Food Trails', 'Heritage Walks', 'Local Immersion', 'Cultural Tours', 'Festivals & Fairs'] },
  { name: 'Social & Community', icon: '🫂', types: ['Meetups', 'Hobby Groups', 'Volunteer Programs', 'Social Events', 'Cultural Exchange', 'Networking Events'] },
  { name: 'Travel & Getaways', icon: '🧳', types: ['Weekend Getaways', 'Road Trips', 'Staycations', 'Offbeat Destinations', 'Theme Holidays', 'Luxury Escapes'] },
  { name: 'Spiritual & Inner Journeys', icon: '🕉️', types: ['Spiritual Retreats', 'Pilgrimages', 'Meditation Retreats', 'Conscious Travel', 'Silent Retreats', 'Yoga Retreats'] },
  { name: 'Corporate Experiences', icon: '🤝', types: ['Team Building', 'Leadership Retreats', 'Offsites', 'Employee Wellness', 'Training Programs', 'Incentive Travel'] },
];

const run = async () => {
  await sequelize.authenticate();
  console.log('[SEED:exp] Connected to DB');

  let a = 0;
  for (let i = 0; i < AUDIENCES.length; i++) {
    const x = AUDIENCES[i];
    const [, made] = await ExperienceAudience.findOrCreate({
      where: { slug: slug(x.name) },
      defaults: { name: x.name, slug: slug(x.name), icon: x.icon, description: x.description, sortOrder: i, isCustom: false },
    });
    if (made) a++;
  }
  console.log(`[SEED:exp] Audiences: +${a} created (${AUDIENCES.length} total)`);

  let c = 0; let t = 0;
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    const [catRow, madeCat] = await ExperienceCategory.findOrCreate({
      where: { slug: slug(cat.name) },
      defaults: { name: cat.name, slug: slug(cat.name), icon: cat.icon, sortOrder: i, isCustom: false },
    });
    if (madeCat) c++;
    for (let j = 0; j < cat.types.length; j++) {
      const ty = cat.types[j];
      const [, madeType] = await ExperienceType.findOrCreate({
        where: { categoryId: catRow.id, slug: slug(ty) },
        defaults: { categoryId: catRow.id, name: ty, slug: slug(ty), sortOrder: j, isCustom: false },
      });
      if (madeType) t++;
    }
  }
  console.log(`[SEED:exp] Categories: +${c} created · Types: +${t} created`);
  console.log('[SEED:exp] DONE');
  process.exit(0);
};

run().catch((err) => { console.error('[SEED:exp] Failed:', err); process.exit(1); });

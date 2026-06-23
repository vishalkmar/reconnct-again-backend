/**
 * Seed the Reconnct audience → category → subcategory taxonomy from the
 * "Reconnect Category" sheet. Each broad category is tagged with the
 * audience(s) it belongs to (category.audiences = [audienceSlug,…]) so the
 * admin form can filter categories by the selected "Who is this for?".
 *
 * A category that appears under several audiences (e.g. "Learning Together")
 * collects all of them, and its types are the UNION across those audiences.
 *
 * Idempotent (findOrCreate by slug; audiences merged). Run manually:
 *   npm run seed:reconnct-taxonomy
 */
require('dotenv').config();
const slugify = require('slugify');
const {
  sequelize, ExperienceAudience, ExperienceCategory, ExperienceType,
} = require('../models');

const slug = (s) => slugify(String(s), { lower: true, strict: true });

// Excel "Reconnect with X" → existing audience slug + display name + icon.
const AUDIENCES = {
  self: { name: 'Self', icon: '🧘' },
  partner: { name: 'Partner', icon: '💞' },
  'kids-and-teens': { name: 'Kids & Teens', icon: '🧒' },
  'elders-and-active-seniors': { name: 'Elders & Active Seniors', icon: '🧓' },
  family: { name: 'Family', icon: '👨‍👩‍👧' },
  friends: { name: 'Friends', icon: '🧑‍🤝‍🧑' },
  'community-and-new-connections': { name: 'Community & New Connections', icon: '👥' },
  'corporate-and-teams': { name: 'Corporate & Teams', icon: '💼' },
};

const CAT_ICON = {
  'Wellness & Healing': '🌿', 'Personal Growth': '🌱', Creativity: '🎨', 'Fitness & Adventure': '⛰️',
  'Romantic Experiences': '❤️', 'Wellness Together': '🧖', 'Adventure Together': '🧗', 'Learning Together': '📚',
  'Learning & Discovery': '🔬', 'Creative Activities': '🖍️', 'Adventure & Play': '🎢', 'Nature Experiences': '🌳', 'Family Experiences': '👪',
  'Wellness & Relaxation': '💆', 'Heritage & Culture': '🏛️', 'Spiritual Experiences': '🕉️', 'Leisure Travel': '🚂',
  'Family Holidays': '🏖️', Entertainment: '🎭', 'Social Experiences': '🎲', Adventure: '🪂', 'Food & Nightlife': '🍽️',
  'Group Travel': '🧳', Volunteering: '🤝', 'Social Impact': '🌍', 'Community Events': '🎪', Networking: '🔗',
  'Team Building': '🧩', Wellness: '🧘', 'Learning & Development': '📈', 'Recognition & Celebration': '🎉',
};

// audienceSlug → { categoryName: [subcategory/type, …] }
const DATA = {
  self: {
    'Wellness & Healing': ['Yoga Retreats', 'Meditation Retreats', 'Silent Retreats', 'Ayurveda Retreats', 'Detox Retreats', 'Panchakarma Programs', 'Sound Healing', 'Reiki Healing', 'Breathwork Sessions', 'Energy Healing', 'Spa Retreats', 'Wellness Weekends'],
    'Personal Growth': ['Life Coaching', 'Executive Coaching', 'Mindfulness Workshops', 'Emotional Intelligence Workshops', 'Confidence Building Workshops', 'Leadership Retreats', 'Journaling Workshops', 'Vision Board Workshops', 'Goal Setting Retreats'],
    Creativity: ['Pottery Workshops', 'Painting Workshops', 'Art Therapy', 'Photography Workshops', 'Music Workshops', 'Dance Workshops', 'Creative Writing Retreats', 'Floral Arrangement Workshops'],
    'Fitness & Adventure': ['Hiking Retreats', 'Cycling Tours', 'Fitness Bootcamps', 'Marathon Camps', 'Swimming Clinics', 'Martial Arts Workshops'],
  },
  partner: {
    'Romantic Experiences': ['Couple Retreats', 'Luxury Staycations', 'Glamping', 'Sunset Cruises', 'Candlelight Dinners', 'Private Dining', 'Stargazing', 'Hot Air Balloon Rides'],
    'Wellness Together': ['Couple Yoga', 'Couple Meditation', 'Couple Spa', 'Couple Sound Healing', 'Relationship Retreats'],
    'Adventure Together': ['Scuba Diving', 'Trekking', 'Kayaking', 'Sailing', 'Road Trips', 'Camping'],
    'Learning Together': ['Cooking Classes', 'Dance Classes', 'Wine Appreciation', 'Pottery Workshops', 'Art Workshops'],
  },
  'kids-and-teens': {
    'Learning & Discovery': ['Science Workshops', 'Robotics Classes', 'Coding Classes', 'STEM Camps', 'Astronomy Experiences', 'Museum Visits', 'Educational Tours'],
    'Creative Activities': ['Art Workshops', 'Craft Workshops', 'Pottery Classes', 'Music Classes', 'Dance Classes', 'Theatre Workshops', 'Storytelling Sessions'],
    'Adventure & Play': ['Theme Parks', 'Water Parks', 'Trampoline Parks', 'Indoor Play Zones', 'Adventure Parks', 'Zipline Experiences'],
    'Nature Experiences': ['Camping', 'Farm Visits', 'Nature Trails', 'Wildlife Safaris', 'Bird Watching'],
    'Family Experiences': ['Cooking Together', 'Baking Workshops', 'Treasure Hunts', 'DIY Workshops', 'Family Photoshoots'],
  },
  'elders-and-active-seniors': {
    'Wellness & Relaxation': ['Senior Wellness Retreats', 'Ayurveda Retreats', 'Spa Retreats', 'Yoga Programs', 'Nature Retreats'],
    'Heritage & Culture': ['Heritage Walks', 'Museum Tours', 'Cultural Festivals', 'Classical Music Concerts', 'Local Cultural Experiences'],
    'Spiritual Experiences': ['Pilgrimages', 'Ashram Retreats', 'Spiritual Retreats', 'Temple Tours', 'Meditation Retreats'],
    'Leisure Travel': ['Luxury Train Journeys', 'River Cruises', 'Scenic Rail Trips', 'Tea Estate Stays', 'Houseboat Experiences', 'Slow Travel Holidays'],
    'Learning Together': ['Gardening Workshops', 'Cooking Workshops', 'Art Workshops', 'Music Workshops'],
  },
  family: {
    'Family Holidays': ['Family Staycations', 'Family Vacations', 'Family Retreats', 'Multi-Generational Travel'],
    'Learning Together': ['Cooking Workshops', 'Art Workshops', 'Cultural Workshops', 'Gardening Workshops'],
    'Adventure Together': ['Camping', 'Trekking', 'Wildlife Safaris', 'Adventure Parks'],
    Entertainment: ['Theme Parks', 'Water Parks', 'Interactive Museums', 'Festivals', 'Live Shows'],
  },
  friends: {
    'Social Experiences': ['Escape Rooms', 'Karaoke Nights', 'Board Game Cafes', 'Trivia Nights', 'Comedy Shows'],
    Adventure: ['Trekking', 'Camping', 'Rafting', 'Ziplining', 'Rock Climbing', 'ATV Experiences'],
    'Food & Nightlife': ['Food Trails', 'Brewery Tours', 'Wine Tastings', 'Rooftop Experiences', 'Brunch Experiences'],
    'Group Travel': ['Weekend Getaways', 'Backpacking Trips', 'Road Trips', 'Group Retreats'],
  },
  'community-and-new-connections': {
    Volunteering: ['NGO Volunteering', 'Animal Shelter Programs', 'Rural Tourism', 'Community Projects'],
    'Social Impact': ['Sustainability Programs', 'Tree Plantation Drives', 'Beach Cleanups', 'Environmental Campaigns'],
    'Community Events': ['Local Festivals', 'Cultural Gatherings', 'Community Markets', 'Neighbourhood Events'],
    Networking: ['Startup Meetups', 'Entrepreneur Circles', 'Industry Networking Events'],
  },
  'corporate-and-teams': {
    'Team Building': ['Outdoor Team Challenges', 'Adventure Team Activities', 'Corporate Retreats', 'Offsites'],
    Wellness: ['Corporate Wellness Retreats', 'Stress Management Workshops', 'Mindfulness Sessions', 'Yoga Programs'],
    'Learning & Development': ['Leadership Retreats', 'Innovation Workshops', 'Strategy Offsites', 'Skill Development Programs'],
    'Recognition & Celebration': ['Team Outings', 'Annual Celebrations', 'Reward Trips', 'Employee Appreciation Events'],
  },
};

const run = async () => {
  await sequelize.authenticate();
  console.log('[SEED:reconnct] Connected to DB');

  // 1) Ensure audiences exist.
  let aIdx = 0;
  for (const [aslug, meta] of Object.entries(AUDIENCES)) {
    await ExperienceAudience.findOrCreate({
      where: { slug: aslug },
      defaults: { name: meta.name, slug: aslug, icon: meta.icon, sortOrder: aIdx++, isCustom: false },
    });
  }

  // 2) Aggregate categories across audiences (merge audiences + union types).
  const cats = {}; // slug → { name, audiences:Set, types:Set }
  for (const [aslug, categories] of Object.entries(DATA)) {
    for (const [catName, types] of Object.entries(categories)) {
      const cslug = slug(catName);
      if (!cats[cslug]) cats[cslug] = { name: catName, audiences: new Set(), types: new Set() };
      cats[cslug].audiences.add(aslug);
      types.forEach((t) => cats[cslug].types.add(t));
    }
  }

  // 3) Upsert categories + their types.
  let c = 0; let t = 0; let i = 0;
  for (const [cslug, info] of Object.entries(cats)) {
    const audiencesArr = [...info.audiences];
    const [catRow, made] = await ExperienceCategory.findOrCreate({
      where: { slug: cslug },
      defaults: { name: info.name, slug: cslug, icon: CAT_ICON[info.name] || null, audiences: audiencesArr, sortOrder: i++, isCustom: false },
    });
    if (made) c++;
    // Merge audiences on re-run so a category accumulates all its audiences.
    const merged = [...new Set([...(catRow.audiences || []), ...audiencesArr])];
    if (merged.length !== (catRow.audiences || []).length) { catRow.audiences = merged; await catRow.save(); }

    let j = 0;
    for (const typeName of info.types) {
      const [, madeType] = await ExperienceType.findOrCreate({
        where: { categoryId: catRow.id, slug: slug(typeName) },
        defaults: { categoryId: catRow.id, name: typeName, slug: slug(typeName), sortOrder: j++, isCustom: false },
      });
      if (madeType) t++;
    }
  }

  console.log(`[SEED:reconnct] Categories +${c} (of ${Object.keys(cats).length}), Types +${t}`);
  console.log('[SEED:reconnct] DONE');
  process.exit(0);
};

run().catch((err) => { console.error('[SEED:reconnct] Failed:', err); process.exit(1); });

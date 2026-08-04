process.env.SEED_DELHI_TEST='1';
require('dotenv').config();
const { sequelize } = require('./src/config/database');
const { seed } = require('./src/scripts/seedDelhiTestLocations');
const { backfillExperienceCoords } = require('./src/scripts/backfillExperienceCoords');
const c = require('./src/controllers/public.controller');
const run=(lat,lon,radius)=>new Promise(r=>{c.nearbyExperiences({query:{lat,lon,radius,limit:12}},{json:b=>r(b),status(){return this;}});});
(async()=>{
  const s = await seed(); console.log('SEED:', JSON.stringify(s));
  const b = await backfillExperienceCoords({}); console.log('BACKFILL:', JSON.stringify(b));
  // From Connaught Place (center of Delhi)
  const o = await run(28.6304,77.2177,500); const d=o.data||o;
  console.log('\nNear CP -> '+d.count+' experiences (varied distances):');
  (d.experiences||[]).forEach(e=>console.log('  '+e.distanceKm+'km  '+e.name+' ['+e.city+']'));
  await sequelize.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});

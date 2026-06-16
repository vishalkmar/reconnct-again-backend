const ctrl = require('../controllers/nearbyPlace.controller');
const { buildTaxonomyRouter } = require('./factories/taxonomy.routes');

module.exports = buildTaxonomyRouter(ctrl, 'nearby-places');

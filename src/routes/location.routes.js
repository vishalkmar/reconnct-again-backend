const ctrl = require('../controllers/location.controller');
const { buildTaxonomyRouter } = require('./factories/taxonomy.routes');

module.exports = buildTaxonomyRouter(ctrl, 'locations');

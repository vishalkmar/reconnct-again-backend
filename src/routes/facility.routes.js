const ctrl = require('../controllers/facility.controller');
const { buildTaxonomyRouter } = require('./factories/taxonomy.routes');

module.exports = buildTaxonomyRouter(ctrl, 'facilities');

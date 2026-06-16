const ctrl = require('../controllers/problem.controller');
const { buildTaxonomyRouter } = require('./factories/taxonomy.routes');

module.exports = buildTaxonomyRouter(ctrl, 'problems');

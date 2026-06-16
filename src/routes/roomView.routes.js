const ctrl = require('../controllers/roomView.controller');
const { buildTaxonomyRouter } = require('./factories/taxonomy.routes');

module.exports = buildTaxonomyRouter(ctrl, 'room-views');

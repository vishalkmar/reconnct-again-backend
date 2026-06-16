const ctrl = require('../controllers/blogCategory.controller');
const { buildTaxonomyRouter } = require('./factories/taxonomy.routes');

module.exports = buildTaxonomyRouter(ctrl, 'blog-categories');

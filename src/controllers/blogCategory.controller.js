const { BlogCategory } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: BlogCategory,
  subfolder: 'blog-categories',
  label: 'Blog category',
});

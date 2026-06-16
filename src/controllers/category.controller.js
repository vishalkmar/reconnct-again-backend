const { Category } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: Category,
  subfolder: 'categories',
  label: 'Category',
});

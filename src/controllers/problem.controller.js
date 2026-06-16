const { Problem } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: Problem,
  subfolder: 'problems',
  label: 'Problem',
  extraFields: ['icon'],
});

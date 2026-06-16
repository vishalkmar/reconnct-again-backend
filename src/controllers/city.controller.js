const { City } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: City,
  subfolder: 'cities',
  label: 'City',
  extraFields: ['country'],
});

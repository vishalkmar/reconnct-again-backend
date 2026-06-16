const { Location } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: Location,
  subfolder: 'locations',
  label: 'Location',
  extraFields: ['country'],
});

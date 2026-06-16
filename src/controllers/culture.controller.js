const { Culture } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: Culture,
  subfolder: 'cultures',
  label: 'Culture',
});

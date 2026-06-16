const { Area } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: Area,
  subfolder: 'areas',
  label: 'Area',
});

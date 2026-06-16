const { Facility } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: Facility,
  subfolder: 'facilities',
  label: 'Facility',
  extraFields: ['icon'],
});

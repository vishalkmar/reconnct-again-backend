const { Activity } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: Activity,
  subfolder: 'activities',
  label: 'Activity',
  extraFields: ['icon'],
});

const { NearbyPlace } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: NearbyPlace,
  subfolder: 'nearby-places',
  label: 'Nearby Place',
});

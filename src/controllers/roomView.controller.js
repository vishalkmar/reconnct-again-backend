const { RoomView } = require('../models');
const { buildTaxonomyController } = require('./factories/taxonomy.factory');

module.exports = buildTaxonomyController({
  Model: RoomView,
  subfolder: 'room-views',
  label: 'Room View',
});

const dbFactory = require('../config/database');

function getModels() {
  if (dbFactory.isMongoDB()) {
    return require('./mongodb');
  } else {
    return require('./sql').getModels();
  }
}

module.exports = getModels;

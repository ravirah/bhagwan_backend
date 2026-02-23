// Passenger entry point for GlobeHost shared hosting
// This file is used by Phusion Passenger to start the Node.js application
// Do not modify unless you understand Passenger's requirements

require('dotenv').config();
const app = require('./server.js');

module.exports = app;

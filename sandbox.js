'use strict';
const path = require('path');

process.env.APP_ENV = 'sandbox';
process.env.PORT = process.env.PORT || '4243';

require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.sandbox'), override: true });

if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = path.join(__dirname, 'data-sandbox');
}

require('./server.js');

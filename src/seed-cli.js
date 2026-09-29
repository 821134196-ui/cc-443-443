'use strict';

// 强制重建样例数据：node src/seed-cli.js
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { createApp } = require('./app');
const app = createApp({ dataDir: DATA_DIR, seedIfEmpty: true, withTasks: false });
app.db.close();
console.log(`样例数据已导入 ${DATA_DIR}`);

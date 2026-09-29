'use strict';

const path = require('node:path');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const { server } = createApp({ dataDir: DATA_DIR, seedIfEmpty: true, withTasks: true });

server.listen(PORT, () => {
  console.log('');
  console.log('  商场母婴室巡检与耗材补给系统');
  console.log(`  ➜ 前端 + API:  http://localhost:${PORT}`);
  console.log(`  ➜ 数据目录:    ${DATA_DIR}（SQLite + 故障照片）`);
  console.log('');
});

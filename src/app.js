'use strict';

const path = require('node:path');
const cfg = require('./config');
const { openDb, isSeeded } = require('./db');
const { buildApi } = require('./api');
const { createHttpServer } = require('./http');
const { SimulatedTemperatureAdapter } = require('./adapters/temperature');
const { startTasks } = require('./tasks');
const { seed } = require('./seed');

/**
 * 装配整个应用：SQLite + API + 静态前端 + 照片目录 + 进程内任务。
 * 测试可用临时 dataDir 并关闭任务循环。
 */
function createApp({ dataDir, seedIfEmpty = true, withTasks = true, tickMs } = {}) {
  const dir = dataDir || path.join(__dirname, '..', 'data');
  const photosDir = path.join(dir, 'photos');
  const db = openDb(dir);
  const adapter = new SimulatedTemperatureAdapter();
  if (seedIfEmpty && !isSeeded(db)) {
    seed(db, cfg, adapter, photosDir);
    console.log('[app] 已导入巡检样例数据');
  }
  const router = buildApi({ db, cfg, adapter, photosDir });
  const server = createHttpServer({
    router,
    publicDir: path.join(__dirname, '..', 'public'),
    photosDir,
  });
  const stopTasks = withTasks ? startTasks(db, cfg, adapter, tickMs) : null;
  return { server, db, adapter, cfg, stopTasks };
}

module.exports = { createApp };

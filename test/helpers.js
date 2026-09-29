'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../src/app');

/** 启动一个隔离的测试实例（临时数据目录、随机端口、不跑后台节拍）。 */
async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mall-test-'));
  const app = createApp({ dataDir: dir, seedIfEmpty: true, withTasks: false });
  await new Promise((res) => app.server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    base,
    async close() {
      await new Promise((r) => app.server.close(r));
      app.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function req(base, method, p, { staff, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(staff ? { 'X-Staff-Id': String(staff) } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** 种子员工：1 林岚(巡检,限一层) 2 周敏(巡检,限二层) 3 陈果(补货) 4 唐欣(补货) 5 赵工(维修) 6 吴主管(主管) */
const STAFF = { LIN: 1, ZHOU: 2, CHEN: 3, TANG: 4, ZHAO: 5, WU: 6 };

function passItems(extra = {}) {
  return {
    door_lock: { result: 'pass' },
    water_temp: { result: 'pass', value: 40 },
    outlet: { result: 'pass' },
    odor: { result: 'pass' },
    cleanliness: { result: 'pass' },
    ...extra,
  };
}

module.exports = { startApp, req, STAFF, passItems };

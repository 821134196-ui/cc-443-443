'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, req, STAFF, passItems } = require('./helpers');
const { runTick } = require('../src/tasks');
const { SimulatedTemperatureAdapter } = require('../src/adapters/temperature');

let ctx;
let adapter; // 确定性适配器（无随机尖峰），避免测试抖动
before(async () => {
  ctx = await startApp();
  adapter = new SimulatedTemperatureAdapter({ spikeChance: 0 });
});
after(async () => { await ctx.close(); });

test('温度异常：模拟适配器读数超温 → 关闭热水设备并升级工程负责人', async () => {
  // 找到房间 3 的热水设备
  const facs = await req(ctx.base, 'GET', '/api/facilities?floor_id=1');
  const heater = facs.data.find((f) => f.room_name.includes('C') && f.type === 'water_heater');
  assert.ok(heater);
  assert.equal(heater.status, 'ok');

  // 注入 52℃ 超温读数，跑一拍进程内任务（温度轮询）
  adapter.setOverride(heater.id, 52);
  const out = runTick(ctx.app.db, ctx.app.cfg, adapter);
  assert.equal(out.tempEvents.length, 1);
  assert.equal(out.tempEvents[0].facility_id, heater.id);

  // 设施已关闭
  const after1 = await req(ctx.base, 'GET', '/api/facilities?floor_id=1');
  const h2 = after1.data.find((f) => f.id === heater.id);
  assert.equal(h2.status, 'fault', '超温应关闭热水设备');

  // 升级给工程负责人
  const esc = await req(ctx.base, 'GET', '/api/escalations?status=open');
  const ot = esc.data.filter((e) => e.type === 'overtemp');
  assert.equal(ot.length, 1);
  assert.equal(ot[0].assignee_role, 'engineering_lead');

  // 幂等：持续超温不重复升级
  runTick(ctx.app.db, ctx.app.cfg, adapter);
  const esc2 = await req(ctx.base, 'GET', '/api/escalations?status=open');
  assert.equal(esc2.data.filter((e) => e.type === 'overtemp').length, 1, '不应重复升级');

  // 温度读数已落库
  const temps = await req(ctx.base, 'GET', '/api/temperature?floor_id=1');
  const t = temps.data.find((x) => x.facility_id === heater.id);
  assert.equal(t.celsius, 52);
});

test('温度异常：巡检录入超温读数 → 同样触发闭设施与升级', async () => {
  const r = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.ZHOU,
    body: {
      room_id: 5, // 二层 E
      items: passItems({ water_temp: { result: 'pass', value: 51.5 } }),
      consumables: { paper_towel: 15, cleaning_bag: 25 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.escalations.includes('overtemp'), '巡检超温应触发超温升级');
  const facs = await req(ctx.base, 'GET', '/api/facilities?floor_id=2');
  const heater = facs.data.find((f) => f.room_name.includes('E') && f.type === 'water_heater');
  assert.equal(heater.status, 'fault');
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, req, STAFF, passItems } = require('./helpers');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('低库存触发：耗材低于安全量自动进入补给队列，且不重复生成', async () => {
  // 房间 1 纸巾安全量 6，巡检登记余量 3 → 应自动生成补给单
  const r1 = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 1,
      items: passItems(),
      consumables: { paper_towel: 3, cleaning_bag: 20 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.orders.length, 1, '应生成 1 张补给单');

  const list = await req(ctx.base, 'GET', '/api/replenishments?floor_id=1');
  const order = list.data.orders.find((o) => o.room_id === 1 && o.item === 'paper_towel');
  assert.ok(order, '补给队列中应存在房间 1 的纸巾补给单');
  assert.equal(order.status, 'pending');
  assert.equal(order.qty, 17, '补给量 = 容量20 - 余量3');
  assert.ok(order.deadline_at, '应计算补给时限');

  // 房间耗材余量已入账
  const room = await req(ctx.base, 'GET', '/api/rooms/1');
  const pt = room.data.consumables.find((c) => c.item === 'paper_towel');
  assert.equal(pt.quantity, 3);

  // 再次巡检仍低于安全量 → 不重复生成（同一耗材只保留一张进行中的单）
  const r2 = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 1,
      items: passItems(),
      consumables: { paper_towel: 2, cleaning_bag: 20 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.orders.length, 0, '已有进行中的补给单，不应重复生成');
  const list2 = await req(ctx.base, 'GET', '/api/replenishments?floor_id=1&active=1');
  assert.equal(list2.data.orders.filter((o) => o.room_id === 1 && o.item === 'paper_towel').length, 1);
});

test('补给时限：进程内任务将超时未上架的单据标记提醒并升级仓储主管', async () => {
  // 把上一测试生成的补给单时限改到过去，跑一拍任务
  ctx.app.db.prepare("UPDATE replenishment_orders SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE status = 'pending'").run();
  const { runTick } = require('../src/tasks');
  const { SimulatedTemperatureAdapter } = require('../src/adapters/temperature');
  runTick(ctx.app.db, ctx.app.cfg, new SimulatedTemperatureAdapter({ spikeChance: 0 }));

  const reminders = await req(ctx.base, 'GET', '/api/reminders?floor_id=1');
  assert.ok(reminders.data.some((r) => r.kind === 'restock_overdue'), '应生成补给超时提醒');
  const esc = await req(ctx.base, 'GET', '/api/escalations?status=open');
  assert.ok(esc.data.some((e) => e.type === 'restock_overdue' && e.assignee_role === 'stock_lead'), '应升级仓储主管');
});

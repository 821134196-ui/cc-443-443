'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, req, STAFF, passItems } = require('./helpers');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('并发领单：同一补给单两人同时领取，只保留首个领取者', async () => {
  // 造一张待领料的补给单（房间 1 纸巾低于安全量）
  const insp = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 1,
      items: passItems(),
      consumables: { paper_towel: 2, cleaning_bag: 20 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(insp.status, 200);
  const orderId = insp.data.orders[0];
  assert.ok(orderId);

  // 陈果、唐欣同时领取
  const [a, b] = await Promise.all([
    req(ctx.base, 'POST', `/api/replenishments/${orderId}/claim`, { staff: STAFF.CHEN }),
    req(ctx.base, 'POST', `/api/replenishments/${orderId}/claim`, { staff: STAFF.TANG }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], '一人成功一人冲突');
  assert.equal((a.status === 409 ? a : b).data.error, 'already_claimed');

  // 数据库中只保留一个领取者，且仓库只扣减一次
  const list = await req(ctx.base, 'GET', '/api/replenishments?floor_id=1');
  const order = list.data.orders.find((o) => o.id === orderId);
  const winner = a.status === 200 ? STAFF.CHEN : STAFF.TANG;
  assert.equal(order.claimed_by, winner);
  assert.equal(order.status, 'claimed');
  const wh = list.data.warehouse.find((w) => w.item === 'paper_towel');
  assert.equal(wh.quantity, 50 - order.qty, '仓库库存只应扣减一次');

  // 重复领取仍被拒绝（幂等保护）
  const again = await req(ctx.base, 'POST', `/api/replenishments/${orderId}/claim`, { staff: STAFF.TANG });
  assert.equal(again.status, 409);
});

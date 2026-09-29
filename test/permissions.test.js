'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, req, STAFF, passItems } = require('./helpers');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('跨楼层权限：限一层巡检员不能操作二层资源', async () => {
  // 林岚（floors=[1]）巡检二层房间 4 → 403
  const r1 = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 4,
      items: passItems(),
      consumables: { paper_towel: 15, cleaning_bag: 25 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r1.status, 403);
  assert.equal(r1.data.error, 'forbidden_floor');

  // 林岚闭用二层房间 → 403
  const r2 = await req(ctx.base, 'POST', '/api/rooms/4/close', { staff: STAFF.LIN, body: { reason: '越权测试' } });
  assert.equal(r2.status, 403);
  assert.equal(r2.data.error, 'forbidden_floor');

  // 林岚在二层开班次 → 403
  const r3 = await req(ctx.base, 'POST', '/api/shifts', { staff: STAFF.LIN, body: { floor_id: 2 } });
  assert.equal(r3.status, 403);
});

test('跨楼层权限：本楼层巡检员与主管可正常操作', async () => {
  // 周敏（floors=[2]）巡检二层房间 4 → 200
  const r1 = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.ZHOU,
    body: {
      room_id: 4,
      items: passItems(),
      consumables: { paper_towel: 15, cleaning_bag: 25 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));

  // 主管（不限楼层）操作一层房间 → 200
  const r2 = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.WU,
    body: {
      room_id: 1,
      items: passItems(),
      consumables: { paper_towel: 15, cleaning_bag: 25 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r2.status, 200);

  // 未登录不可提交巡检
  const r3 = await req(ctx.base, 'POST', '/api/inspections', {
    body: { room_id: 1, items: passItems() },
  });
  assert.equal(r3.status, 401);
});

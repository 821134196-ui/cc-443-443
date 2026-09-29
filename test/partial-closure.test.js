'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, req, STAFF, passItems } = require('./helpers');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('局部闭用：单设施故障只关闭该设施，其余隔间不受影响', async () => {
  // 房间 3（一层 C）插座 A 异常
  const before1 = await req(ctx.base, 'GET', '/api/rooms/3');
  const outletA = before1.data.facilities.find((f) => f.type === 'power_outlet');
  const r = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 3,
      items: passItems({ outlet: { result: 'fail', note: '面板烧焦', facility_id: outletA.id } }),
      consumables: { paper_towel: 15, cleaning_bag: 25 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.faults.length, 1);

  const d = await req(ctx.base, 'GET', '/api/rooms/3');
  const byId = Object.fromEntries(d.data.facilities.map((f) => [f.id, f]));
  assert.equal(byId[outletA.id].status, 'fault', '故障插座应关闭');
  const booths = d.data.facilities.filter((f) => f.type === 'nursing_booth');
  assert.ok(booths.every((b) => b.status === 'ok'), '哺乳隔间不受影响');
  assert.equal(d.data.room.status, 'open', '房间整体仍开放');
});

test('整间闭用后：存在未解决故障时禁止重开，复测通过后方可重新开放', async () => {
  // 房间 3 当前有 1 条插座故障（上一测试）
  const close = await req(ctx.base, 'POST', '/api/rooms/3/close', { staff: STAFF.LIN, body: { reason: '电路检修' } });
  assert.equal(close.status, 200);

  // 有未解决故障 → 重开被拒
  const reopen1 = await req(ctx.base, 'POST', '/api/rooms/3/reopen', { staff: STAFF.LIN });
  assert.equal(reopen1.status, 409);
  assert.equal(reopen1.data.error, 'unresolved_faults');

  // 维修认领 → 复测不通过 → 仍不可重开
  const faults = await req(ctx.base, 'GET', '/api/faults?status=open&floor_id=1');
  const fault = faults.data.find((f) => f.room_name.includes('C'));
  assert.ok(fault);
  assert.equal((await req(ctx.base, 'POST', `/api/faults/${fault.id}/claim`, { staff: STAFF.ZHAO })).status, 200);
  const fail = await req(ctx.base, 'POST', `/api/faults/${fault.id}/retest`, { staff: STAFF.ZHAO, body: { result: 'fail', note: '仍有漏电' } });
  assert.equal(fail.status, 200);
  assert.equal((await req(ctx.base, 'POST', '/api/rooms/3/reopen', { staff: STAFF.LIN })).status, 409);

  // 复测通过 → 设施自动重开 → 房间可重新开放
  const pass = await req(ctx.base, 'POST', `/api/faults/${fault.id}/retest`, { staff: STAFF.ZHAO, body: { result: 'pass' } });
  assert.equal(pass.status, 200);
  assert.equal(pass.data.facility_reopened, true, '复测通过应重新开放设施');
  const reopen2 = await req(ctx.base, 'POST', '/api/rooms/3/reopen', { staff: STAFF.LIN });
  assert.equal(reopen2.status, 200);

  const d = await req(ctx.base, 'GET', '/api/rooms/3');
  assert.equal(d.data.room.status, 'open');
  assert.ok(d.data.facilities.every((f) => f.status === 'ok'), '全部设施恢复可用');
});

test('整间闭用触发升级给运营经理', async () => {
  const esc = await req(ctx.base, 'GET', '/api/escalations?status=open');
  const closure = esc.data.find((e) => e.type === 'room_closure');
  assert.ok(closure, '应存在整间闭用升级');
  assert.equal(closure.assignee_role, 'ops_manager');
});

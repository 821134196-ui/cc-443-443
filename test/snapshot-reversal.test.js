'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, req, STAFF, passItems } = require('./helpers');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('班次快照不可覆盖：数据库层面拒绝 UPDATE/DELETE', async () => {
  const r = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 1,
      items: passItems(),
      consumables: { paper_towel: 15, cleaning_bag: 25 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  assert.equal(r.status, 200);
  const id = r.data.inspection_id;
  assert.ok(r.data.hash);

  assert.throws(
    () => ctx.app.db.prepare('UPDATE inspections SET snapshot = ? WHERE id = ?').run('{}', id),
    /immutable/,
    'UPDATE 应被触发器拒绝'
  );
  assert.throws(
    () => ctx.app.db.prepare('DELETE FROM inspections WHERE id = ?').run(id),
    /immutable/,
    'DELETE 应被触发器拒绝'
  );

  // 哈希链：快照携带前序哈希
  const snap = await req(ctx.base, 'GET', `/api/inspections/${id}`);
  assert.ok('prev_hash' in snap.data);
  assert.equal(snap.data.hash, r.data.hash);
});

test('撤销上架必须由主管复核：批准扣回库存，驳回恢复原状', async () => {
  // 造单并完成 领料→送达→上架（房间 3 清洁袋余量 5 < 安全量 8）
  const insp = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 3,
      items: passItems(),
      consumables: { paper_towel: 15, cleaning_bag: 5 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  const orderId = insp.data.orders[0];
  assert.ok(orderId);
  assert.equal((await req(ctx.base, 'POST', `/api/replenishments/${orderId}/claim`, { staff: STAFF.CHEN })).status, 200);
  assert.equal((await req(ctx.base, 'POST', `/api/replenishments/${orderId}/deliver`, { staff: STAFF.CHEN })).status, 200);
  assert.equal((await req(ctx.base, 'POST', `/api/replenishments/${orderId}/shelve`, { staff: STAFF.CHEN })).status, 200);

  const roomAfterShelve = await req(ctx.base, 'GET', '/api/rooms/3');
  const bagAfterShelve = roomAfterShelve.data.consumables.find((c) => c.item === 'cleaning_bag');
  assert.equal(bagAfterShelve.quantity, 30, '上架后库存入账（5 + 25，封顶容量 30）');

  // 申请撤销
  const rr = await req(ctx.base, 'POST', `/api/replenishments/${orderId}/reversal-requests`, {
    staff: STAFF.CHEN, body: { reason: '上架批次错误' },
  });
  assert.equal(rr.status, 200);
  const reversalId = rr.data.reversal_id;

  // 非主管复核 → 403
  const forbidden = await req(ctx.base, 'POST', `/api/reversal-requests/${reversalId}/review`, {
    staff: STAFF.CHEN, body: { approve: true },
  });
  assert.equal(forbidden.status, 403);

  // 主管批准 → 库存扣回、单据退回「已送达」
  const ok = await req(ctx.base, 'POST', `/api/reversal-requests/${reversalId}/review`, {
    staff: STAFF.WU, body: { approve: true },
  });
  assert.equal(ok.status, 200);
  const roomAfterReversal = await req(ctx.base, 'GET', '/api/rooms/3');
  const bagAfterReversal = roomAfterReversal.data.consumables.find((c) => c.item === 'cleaning_bag');
  assert.equal(bagAfterReversal.quantity, 5, '撤销上架应扣回已入账库存');
  const list = await req(ctx.base, 'GET', '/api/replenishments?floor_id=1');
  assert.equal(list.data.orders.find((o) => o.id === orderId).status, 'delivered');
});

test('缺货替代：仓库不足时领料标记替代，登记后升级采购负责人', async () => {
  // 清空仓库清洁袋库存
  ctx.app.db.prepare("UPDATE warehouse_stock SET quantity = 0 WHERE item = 'cleaning_bag'").run();
  const insp = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.ZHOU,
    body: {
      room_id: 5,
      items: passItems(),
      consumables: { paper_towel: 15, cleaning_bag: 2 },
      disinfection_done: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
    },
  });
  const orderId = insp.data.orders[0];
  const claim = await req(ctx.base, 'POST', `/api/replenishments/${orderId}/claim`, { staff: STAFF.TANG });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.needs_substitution, 1, '仓库缺货应标记需要替代');

  // 未登记替代前不能确认送达
  const deliver = await req(ctx.base, 'POST', `/api/replenishments/${orderId}/deliver`, { staff: STAFF.TANG });
  assert.equal(deliver.status, 409);
  assert.equal(deliver.data.error, 'substitution_required');

  // 登记替代 → 升级采购负责人 → 可继续送达
  const sub = await req(ctx.base, 'POST', `/api/replenishments/${orderId}/substitute`, {
    staff: STAFF.TANG, body: { substituted_item: '可降解垃圾袋（替代装）' },
  });
  assert.equal(sub.status, 200);
  const esc = await req(ctx.base, 'GET', '/api/escalations?status=open');
  const s = esc.data.find((e) => e.type === 'substitution');
  assert.ok(s, '应产生缺货替代升级');
  assert.equal(s.assignee_role, 'procurement_lead');
  assert.equal((await req(ctx.base, 'POST', `/api/replenishments/${orderId}/deliver`, { staff: STAFF.TANG })).status, 200);
});

test('连续报障升级楼层经理；消毒漏项升级保洁主管', async () => {
  // 同一设施（房间 1 哺乳隔间 1）窗口期内报障 3 次
  const room = await req(ctx.base, 'GET', '/api/rooms/1');
  const booth = room.data.facilities.find((f) => f.type === 'nursing_booth');
  for (let i = 0; i < 3; i++) {
    const r = await req(ctx.base, 'POST', '/api/reports', {
      body: { room_id: 1, facility_id: booth.id, category: '门扣损坏', description: `第 ${i + 1} 次` },
    });
    assert.equal(r.status, 200);
  }
  const esc = await req(ctx.base, 'GET', '/api/escalations?status=open');
  const repeat = esc.data.find((e) => e.type === 'repeat_fault');
  assert.ok(repeat, '连续报障应升级');
  assert.equal(repeat.assignee_role, 'floor_manager');

  // 消毒漏项
  const r2 = await req(ctx.base, 'POST', '/api/inspections', {
    staff: STAFF.LIN,
    body: {
      room_id: 1,
      items: passItems(),
      consumables: { paper_towel: 15, cleaning_bag: 25 },
      disinfection_done: ['尿布台台面'], // 漏 4 项
    },
  });
  assert.equal(r2.status, 200);
  assert.ok(r2.data.escalations.includes('disinfection_missed'));
  const esc2 = await req(ctx.base, 'GET', '/api/escalations?status=open');
  const dis = esc2.data.find((e) => e.type === 'disinfection_missed' && e.room_id === 1);
  assert.ok(dis);
  assert.equal(dis.assignee_role, 'sanitation_lead');
});

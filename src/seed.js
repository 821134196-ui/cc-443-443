'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { now } = require('./util');
const domain = require('./domain');

/** 中性占位故障照片（非插画）：灰底斜纹 + 文字说明。 */
const SAMPLE_PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
  <rect width="960" height="640" fill="#e8e6e1"/>
  <g stroke="#d4d0c8" stroke-width="14">
    <line x1="-80" y1="720" x2="720" y2="-80"/><line x1="120" y1="720" x2="920" y2="-80"/>
    <line x1="320" y1="720" x2="1120" y2="-80"/><line x1="-280" y1="720" x2="520" y2="-80"/>
  </g>
  <rect x="280" y="220" width="400" height="200" rx="12" fill="#f7f5f1" stroke="#b9b3a7" stroke-width="3"/>
  <text x="480" y="300" font-family="sans-serif" font-size="34" fill="#6b675f" text-anchor="middle">故障照片示例</text>
  <text x="480" y="352" font-family="sans-serif" font-size="24" fill="#8a857c" text-anchor="middle">插座面板松动 · 2F 母婴室 D</text>
</svg>`;

function seedStaff(db) {
  const ins = db.prepare('INSERT INTO staff (name, role, floors, pin) VALUES (?, ?, ?, ?)');
  const rows = [
    ['林岚', 'inspector', JSON.stringify([1])],   // 仅一层 —— 跨楼层权限测试/演示
    ['周敏', 'inspector', JSON.stringify([2])],
    ['陈果', 'stocker', null],
    ['唐欣', 'stocker', null],
    ['赵工', 'maintenance', null],
    ['吴主管', 'supervisor', null],
    ['孙采购', 'procurement_lead', null],
    ['郑工程', 'engineering_lead', null],
    ['王保洁', 'sanitation_lead', null],
    ['钱经理', 'floor_manager', null],
    ['冯运营', 'ops_manager', null],
    ['何仓储', 'stock_lead', null],
  ];
  const ids = {};
  for (const [name, role, floors] of rows) {
    const r = ins.run(name, role, floors, '0000');
    ids[name] = Number(r.lastInsertRowid);
  }
  return ids;
}

function seedStructure(db, cfg) {
  const floorIns = db.prepare('INSERT INTO floors (code, name) VALUES (?, ?)');
  const f1 = Number(floorIns.run('F1', '一层').lastInsertRowid);
  const f2 = Number(floorIns.run('F2', '二层').lastInsertRowid);

  const roomIns = db.prepare('INSERT INTO rooms (floor_id, code, name) VALUES (?, ?, ?)');
  const facIns = db.prepare('INSERT INTO facilities (room_id, type, label, status, updated_at) VALUES (?, ?, ?, ?, ?)');
  const consIns = db.prepare('INSERT INTO consumables (room_id, item, label, quantity, safety_level, capacity, unit) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const rooms = [
    { floor: f1, code: '1F-M01', name: '一层母婴室 A' },
    { floor: f1, code: '1F-M02', name: '一层母婴室 B' },
    { floor: f1, code: '1F-M03', name: '一层母婴室 C' },
    { floor: f2, code: '2F-M01', name: '二层母婴室 D' },
    { floor: f2, code: '2F-M02', name: '二层母婴室 E' },
  ];
  const ts = now();
  const roomIds = [];
  for (const rm of rooms) {
    const roomId = Number(roomIns.run(rm.floor, rm.code, rm.name).lastInsertRowid);
    roomIds.push(roomId);
    const facs = [
      ['door_lock', '门锁'],
      ['diaper_table', '尿布台 1'], ['diaper_table', '尿布台 2'],
      ['nursing_booth', '哺乳隔间 1'], ['nursing_booth', '哺乳隔间 2'], ['nursing_booth', '哺乳隔间 3'],
      ['water_heater', '热水设备'],
      ['power_outlet', '插座 A'], ['power_outlet', '插座 B'],
    ];
    for (const [type, label] of facs) facIns.run(roomId, type, label, 'ok', ts);
    for (const [item, meta] of Object.entries(cfg.CONSUMABLES)) {
      consIns.run(roomId, item, meta.label, meta.capacity, meta.safety, meta.capacity, meta.unit);
    }
  }
  return { floors: [f1, f2], roomIds };
}

/** 导入巡检样例：正常巡检、低库存触发补给、消毒漏项、局部闭用、顾客报障、维修中待复检。 */
function seedSamples(db, cfg, adapter, staffIds, roomIds, photosDir) {
  const [r1, r2, r3, r4] = roomIds;
  const lin = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffIds['林岚']);
  const zhou = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffIds['周敏']);
  const zhao = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffIds['赵工']);

  // 样例 1：一层 A 全部正常
  domain.submitInspection(db, cfg, adapter, lin, {
    room_id: r1,
    items: {
      door_lock: { result: 'pass' }, water_temp: { result: 'pass', value: 40.2 },
      outlet: { result: 'pass' }, odor: { result: 'pass' }, cleanliness: { result: 'pass' },
    },
    consumables: { paper_towel: 14, cleaning_bag: 22 },
    disinfection_done: [...cfg.REQUIRED_DISINFECTION],
  });

  // 样例 2：一层 B 纸巾低于安全量（自动生成补给单）+ 消毒漏项（地面）
  domain.submitInspection(db, cfg, adapter, lin, {
    room_id: r2,
    items: {
      door_lock: { result: 'pass' }, water_temp: { result: 'pass', value: 39.8 },
      outlet: { result: 'pass' }, odor: { result: 'pass' }, cleanliness: { result: 'pass' },
    },
    consumables: { paper_towel: 4, cleaning_bag: 18 },
    disinfection_done: cfg.REQUIRED_DISINFECTION.filter((x) => x !== '地面'),
  });

  // 样例 3：二层 D 插座异常（局部闭用：仅插座 A 关闭，隔间照常）+ 故障照片
  const photoName = 'sample-outlet-fault.svg';
  fs.writeFileSync(path.join(photosDir, photoName), SAMPLE_PHOTO_SVG);
  const outletA = db.prepare("SELECT id FROM facilities WHERE room_id = ? AND type = 'power_outlet' ORDER BY id LIMIT 1").get(r4);
  domain.submitInspection(db, cfg, adapter, zhou, {
    room_id: r4,
    items: {
      door_lock: { result: 'pass' }, water_temp: { result: 'pass', value: 41.1 },
      outlet: { result: 'fail', note: '插座面板松动，有打火痕迹', facility_id: outletA.id, photo_path: `/photos/${photoName}` },
      odor: { result: 'pass' }, cleanliness: { result: 'pass' },
    },
    consumables: { paper_towel: 12, cleaning_bag: 20 },
    disinfection_done: [...cfg.REQUIRED_DISINFECTION],
  });

  // 样例 4：顾客报障（不采集身份）—— 一层 A 哺乳隔间 1 门扣损坏
  const booth1 = db.prepare("SELECT id FROM facilities WHERE room_id = ? AND type = 'nursing_booth' ORDER BY id LIMIT 1").get(r1);
  domain.reportFault(db, cfg, {
    roomId: r1, facilityId: booth1.id, category: '门扣损坏',
    description: '隔间门扣无法反锁', source: 'customer',
  });

  // 样例 5：二层 D 的插座故障由维修员认领 → 处于「维修中」，等待复检
  const openFault = db.prepare("SELECT id FROM fault_reports WHERE room_id = ? AND status = 'open' ORDER BY id LIMIT 1").get(r4);
  if (openFault) domain.claimFault(db, zhao, openFault.id);
}

function seed(db, cfg, adapter, photosDir) {
  const staffIds = seedStaff(db);
  const { roomIds } = seedStructure(db, cfg);
  const wh = db.prepare('INSERT INTO warehouse_stock (item, label, quantity) VALUES (?, ?, ?)');
  wh.run('paper_towel', '纸巾', 50);
  wh.run('cleaning_bag', '清洁袋', 40);
  seedSamples(db, cfg, adapter, staffIds, roomIds, photosDir);
}

module.exports = { seed };

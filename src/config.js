'use strict';

// 全局业务参数（可用环境变量覆盖，便于测试调快时钟）
module.exports = {
  TEMP_LIMIT_C: Number(process.env.TEMP_LIMIT_C || 45),        // 热水安全上限（℃）
  RESTOCK_SLA_MIN: Number(process.env.RESTOCK_SLA_MIN || 120), // 补给时限（分钟）
  RETEST_DUE_MIN: Number(process.env.RETEST_DUE_MIN || 30),    // 维修后复检提醒（分钟）
  REPEAT_FAULT_WINDOW_H: 24,   // 连续报障统计窗口（小时）
  REPEAT_FAULT_THRESHOLD: 3,   // 窗口内同一设施报障达到该次数即升级
  TASK_TICK_MS: Number(process.env.TASK_TICK_MS || 30000),     // 进程内任务节拍
  // 每间母婴室要求完成的消毒项
  REQUIRED_DISINFECTION: ['尿布台台面', '哺乳隔间', '门把手', '洗手台', '地面'],
  // 巡检逐项（移动端逐项点选）
  CHECK_ITEMS: [
    { key: 'door_lock',   label: '门锁' },
    { key: 'water_temp',  label: '水温' },
    { key: 'outlet',      label: '插座' },
    { key: 'odor',        label: '异味' },
    { key: 'cleanliness', label: '清洁度' },
  ],
  // 巡检异常项 → 对应设施类型（用于局部闭用）
  ITEM_FACILITY_TYPE: {
    door_lock: 'door_lock',
    water_temp: 'water_heater',
    outlet: 'power_outlet',
  },
  FACILITY_TYPES: {
    door_lock: '门锁',
    diaper_table: '尿布台',
    nursing_booth: '哺乳隔间',
    water_heater: '热水设备',
    power_outlet: '插座',
  },
  CONSUMABLES: {
    paper_towel:  { label: '纸巾',   unit: '包', capacity: 20, safety: 6 },
    cleaning_bag: { label: '清洁袋', unit: '卷', capacity: 30, safety: 8 },
  },
  // 升级类型 → 负责角色（不同事项升级给不同负责人）
  ESCALATION_ROUTES: {
    substitution:        { role: 'procurement_lead', label: '缺货替代' },
    overtemp:            { role: 'engineering_lead', label: '热水超温' },
    disinfection_missed: { role: 'sanitation_lead',  label: '消毒漏项' },
    repeat_fault:        { role: 'floor_manager',    label: '连续报障' },
    room_closure:        { role: 'ops_manager',      label: '整间闭用' },
    restock_overdue:     { role: 'stock_lead',       label: '补给超时' },
  },
  ROLE_LABELS: {
    inspector: '巡检员', stocker: '补货员', maintenance: '维修员', supervisor: '主管',
    procurement_lead: '采购负责人', engineering_lead: '工程负责人', sanitation_lead: '保洁主管',
    floor_manager: '楼层经理', ops_manager: '运营经理', stock_lead: '仓储主管',
  },
};

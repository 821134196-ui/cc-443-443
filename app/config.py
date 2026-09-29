"""业务常量：巡检项、水温阈值、升级路由、时限策略。"""

# 六项逐检
CHECK_ITEMS = [
    {"key": "door_lock", "name": "门锁", "component": "room"},
    {"key": "water_temp", "name": "水温", "component": "water_heater"},
    {"key": "power_outlet", "name": "插座", "component": "room"},
    {"key": "odor", "name": "异味", "component": "room"},
    {"key": "cleanliness", "name": "清洁度", "component": "room"},
    {"key": "supply_level", "name": "耗材余量", "component": "room"},
]
CHECK_ITEM_MAP = {c["key"]: c for c in CHECK_ITEMS}

FACILITY_TYPES = {
    "changing_table": "尿布台",
    "nursing_booth": "哺乳隔间",
    "water_heater": "热水设备",
}

INVENTORY_KINDS = {"tissue": "纸巾", "bags": "清洁袋"}

# 热水适宜区间（°C）。超温升级工程；过低仅提示。
WATER_MIN_C = 37.0
WATER_MAX_C = 45.0

# 每间母婴室每班次要求的消毒项：每个尿布台 + 哺乳隔间各一条
DISINFECTION_REQUIRED_TYPES = ("changing_table", "nursing_booth")

# 同一对象（房间或设施）近期顾客连续报障阈值与窗口（小时）
REPEATED_REPORT_COUNT = 2
REPEATED_REPORT_WINDOW_HOURS = 24

# 补给时限（小时）：纸巾/清洁袋
SUPPLY_DEADLINE_HOURS = {"tissue": 4, "bags": 6}
# 缺货升级阈值：库存为 0
STOCKOUT_QTY = 0

# 维修复测提醒（小时）
RETEST_REMINDER_HOURS = 24

# 升级类型 -> (负责人 duty, 中文职责)
ESCALATION = {
    "stockout_substitute": ("supply_lead", "补给主管"),
    "hot_water": ("engineer", "设备工程师"),
    "missed_disinfection": ("hygiene_lead", "卫生负责人"),
    "repeated_reports": ("duty_manager", "值班经理"),
    "room_closure": ("floor_manager", "楼层管理员"),
}
ESCALATION_NAMES = {
    "stockout_substitute": "缺货替代",
    "hot_water": "热水超温",
    "missed_disinfection": "消毒漏项",
    "repeated_reports": "连续报障",
    "room_closure": "整间闭用",
}

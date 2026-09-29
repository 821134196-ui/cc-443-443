# 商场母婴室巡检与耗材补给系统

楼层/房间/设施（尿布台、哺乳隔间、热水设备、插座、门锁）巡检、消毒记录、纸巾与清洁袋库存、
临时闭用与顾客报障的一体化系统。**不采集任何真实顾客身份信息**（报障无需登录、不留身份字段）。

## 一条命令启动

```bash
npm start          # 启动前后端（http://localhost:3000），首次启动自动导入巡检样例
```

- 前端 + API 同端口：`http://localhost:3000`
- 数据目录 `./data/`：SQLite（`mall.db`）+ 故障照片（`photos/`，本地文件存储）
- 零 npm 依赖：Node ≥ 22 内置 `node:sqlite` 与 `node:test`
- 其他命令：`npm run seed`（重建样例数据）、`npm test`（场景测试）
- 环境变量：`PORT`、`DATA_DIR`、`TEMP_LIMIT_C`（默认 45℃）、`RESTOCK_SLA_MIN`（默认 120 分钟）、`RETEST_DUE_MIN`（默认 30 分钟）、`TASK_TICK_MS`

## 业务规则实现

| 规则 | 实现 |
| --- | --- |
| 班次快照不可覆盖 | `inspections` 表 UPDATE/DELETE 触发器拒绝 + 哈希链（`prev_hash`/`hash`）防篡改 |
| 故障关闭设施，复测通过才重开 | 故障 → 设施 `fault`；复测 `pass` 且无其他未解决故障 → 自动 `ok`；其余隔间不受影响 |
| 整间闭用重开门槛 | `POST /api/rooms/:id/reopen` 校验无未解决故障，否则 409 |
| 低库存自动补给 | 巡检登记余量 < 安全量 → 自动生成补给单（同一耗材只保留一张进行中的单），时限 = 创建 + 120 分钟 |
| 领料/送达/上架分别确认 | `pending → claimed → delivered → shelved`，各步独立接口与操作人记录 |
| 并发领单只留首个 | 原子条件更新 `UPDATE … WHERE status='pending'`，败者 409 |
| 撤销上架主管复核 | 申请 → `reversal_pending` → 主管批准（扣回库存、退回「已送达」）/ 驳回 |
| 缺货替代 | 领料时仓库不足 → 标记待替代，登记替代品 → 升级采购负责人后方可送达 |
| 分级升级 | 缺货替代→采购负责人；热水超温→工程负责人；消毒漏项→保洁主管；连续报障（24h≥3 次）→楼层经理；整间闭用→运营经理；补给超时→仓储主管 |
| 进程内任务 | `src/tasks.js` 节拍：温度轮询（模拟适配器）、补给时限扫描、复检提醒 |
| 跨楼层权限 | 员工 `floors` 范围校验，越界 403（样例：林岚限一层） |

## 页面（移动端优先）

总览（紧凑房间条目 + 开放度条）· 巡检（单手大控件、水温读取、实心刻度耗材条）·
设施（实时温度、故障认领）· 补给（队列步进、撤销复核）· 复检（复测通过/不通过）·
交接（班次、快照哈希、升级与提醒）。故障照片点击为大图预览。视觉：柔白 / 鼠尾草绿 / 珊瑚色，无卡通插画。

## 测试

```bash
npm test
```

覆盖：低库存触发与补给时限、局部闭用与复测重开、并发领单、温度异常（适配器 + 巡检两路）、
跨楼层权限，另加快照不可覆盖、撤销上架复核、缺货替代、连续报障/消毒漏项升级。

## 目录结构

```
server.js            启动入口（npm start）
src/
  app.js             装配：DB + API + 静态前端 + 进程内任务
  db.js              SQLite schema（含快照不可覆盖触发器）
  domain.js          领域逻辑（巡检/故障/补给/升级/班次）
  api.js             REST 路由
  tasks.js           进程内任务：温度轮询、补给时限、复检提醒
  adapters/temperature.js  模拟温度适配器（可替换真实网关）
  seed.js            样例数据（含巡检样例）
public/              前端（原生 HTML/CSS/JS）
test/                node:test 场景测试
data/                运行时生成：mall.db + photos/
```

## API 摘要

`GET /api/overview` · `GET /api/rooms/:id` · `POST /api/inspections` · `GET /api/inspections/:id` ·
`POST /api/reports`（公开报障）· `POST /api/faults/:id/claim|retest` · `POST /api/rooms/:id/close|reopen` ·
`GET /api/replenishments` · `POST /api/replenishments/:id/claim|deliver|shelve|substitute` ·
`POST /api/replenishments/:id/reversal-requests` · `POST /api/reversal-requests/:id/review` ·
`GET/POST /api/escalations…` · `GET /api/handover` · `POST /api/shifts` · `POST /api/photos`

身份：请求头 `X-Staff-Id`（演示级，前端右上角切换身份；报障与照片上传为公开接口）。

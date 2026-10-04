# 青年城市体验履约

团市委"万名学子宜昌行"履约后端：把**专业合适的学生带到合适的接待方面前**，并让每一步都成为可核对的履约事实，而不是一轮签到总数。

本仓库零运行时依赖，使用 Node 内置 `node:http` / `node:test`，跨单位数据统一为 `contracts/domain.schema.json` 约定的领域事件信封。

## 目录

- `contracts/domain.schema.json`：领域事件信封与事件枚举（只追加）。
- `src/events/catalog.js`：事件类型、聚合归属与 payload 字段的**唯一登记处**。
- `src/validator.js`：信封校验 `validateEvent` 与入库严格校验 `validateEventStrict`。
- `src/domain.ts`：编译期类型。
- `src/backend/`
  - `store.js`：事件存储（按聚合流追加、版本乐观并发、跨流原子批次、JSONL 日志可选）。
  - `state.js`：聚合纯函数回放（事件是唯一事实来源）。
  - `service.js`：履约命令服务，**全部业务不变量集中于此**。
  - `read-models.js`：出发前看板、活动后四级漏斗、k-匿名公共统计、接待方最小资料包。
  - `http.js`：HTTP 适配层与角色授权。
- `tests/`：契约一致性、存储、逐条业务规则、HTTP 集成与 96 人端到端场景。
- `data/`：中文联调样例。

## 履约规则与实现对照

| 需求 | 规则 | 关键事件 / 读模型 |
| --- | --- | --- |
| 先确认再安排 | 必须先确认专业兴趣、无障碍需求、可用时段，之后才能接受场次；交通住宿只能在接受后安排 | `PARTICIPANT_REGISTERED → PREFERENCE_CONFIRMED → SLOT_OFFERED → SLOT_ACCEPTED → TRANSPORT_ARRANGED / ACCOMMODATION_ARRANGED` |
| 专业对口 | 场次须落在可用时段、不冲突、不超容量、无障碍支持齐备，且专业或兴趣匹配；不匹配须显式审批留痕 | `SLOT_OFFERED.match_score/matched_major` |
| 替代不能单方换入 | 替代活动必须提案→参与者同意才生效，同意事件号回填到变更事件；后勤换车换房可单方记录但断点可见 | `CHANGE_CONSENT_REQUESTED → CHANGE_CONSENT_DECIDED → ITINERARY_CHANGED(consent_event_id)`；看板 `breakpoints` |
| 代签/迟到 | 代签记录原始事实但立即拒收、绝不到场；迟到计到场不计准时，且不能自动算有效交流，须负责人人工复核后仍由双方确认 | `CHECKIN_RECORDED → PROXY_CHECKIN_REJECTED`、`ATTENDANCE_VERIFIED`、`LATE_INTERACTION_REVIEWED`、`INTERACTION_ACKNOWLEDGED ×2` |
| 四级区分 | 报名 ≠ 到场 ≠ 有效交流 ≠ 后续意向；未到场还区分接待取消/后勤断点/本人未到 | 漏斗 `funnel().stages` 与 `slots[].dropout_reason` |
| 接待方最小知情 | 仅白名单字段（姓名/学校/专业/年级/现场无障碍需求），限定本场接待方、有目的与有效期，可撤回；联系方式永不入包 | `DISCLOSURE_GRANTED/REVOKED`、`hostPacket()` |
| 退出保留事实 | 退出/撤回后续联系只停止新安排与新联系，签到、交流、旧意向等已发生事实保留 | `PARTICIPANT_WITHDRAWN`、`FOLLOWUP_CONSENT_REVOKED` |
| 就业只关联不归因 | 必须有来源联系人/渠道与凭据；禁止"参访造成录用"类措辞，自动生成"存在来源联系但不归因"的规范陈述 | `EMPLOYMENT_RESULT_CLAIMED`（字段 `source_type/source_contact/evidence_ref`） |
| 跨项目不重复认领 | 同一参与者×接待方的就业结果仅一个项目可认领，其余拒绝并作为事实留痕 | `DUPLICATE_CLAIM_REJECTED` |
| 匿名不可反推 | 公共统计只发布单维分布（禁止交叉），总样本不足 k 不发布，计数取整到 k 的倍数、小群桶名与人数均不公开 | `publicStats(program, {k})` |
| 出发前看断点 | 容量余量、接待取消、缺交通、车辆超员、住宿无障碍未落实、换车/换房断点、待同意提案 | `departureBoard(program)` |

## HTTP 接口

身份由请求头模拟（生产由网关注入）：`x-role: organizer | participant | host`，`x-actor-id` 为主体标识。

```bash
npm start            # 默认 :3000，可用 PORT 覆盖
```

命令（均为 POST，JSON 请求体）：

```
/participants                              报名（organizer）
/participants/:id/preferences              确认兴趣/无障碍/可用时段（本人或 organizer）
/participants/:id/withdraw                 退出（本人或 organizer）
/participants/:id/revoke-followup          撤回后续联系（本人或 organizer）
/participants/:id/disclosures              授予/撤回接待方最小披露（POST/DELETE）
/hosts                                     登记接待承诺（organizer）
/hosts/:id/cancel                          接待方取消（organizer，批量标记断点）
/slots/offer                               场次邀约（organizer，执行匹配/容量/时段校验）
/slots/:id/respond                         接受或拒绝（场次参与者本人）
/slots/:id/transport  /slots/:id/accommodation
/slots/:id/change-request                  替代/调整提案（organizer）
/slots/:id/change-decision                 同意或拒绝（场次参与者本人）
/slots/:id/logistics-change                换车/换房/时间微调单方记录（organizer）
/slots/:id/checkin                         签到（organizer；代签自动拒收）
/slots/:id/late-review                     迟到交流人工复核（organizer）
/slots/:id/acknowledge                     双方确认实质交流（本人/本接待方各自只能提交本方）
/outcomes/intention  /outcomes/employment
```

读端点：

```
GET /programs/:id/departure-board          出发前容量与断点（organizer）
GET /programs/:id/funnel                   报名→到场→有效交流→后续意向（organizer）
GET /programs/:id/public-stats?k=5         k-匿名单维统计（公开发布即匿名）
GET /hosts/:id/packet?slot_id=...          接待方本场最小资料包（仅本接待方，凭授权）
GET /events                                事件流（organizer）
```

## 事件约定

- 信封七字段保持不变：`event_id / event_type / aggregate_type / aggregate_id / occurred_at / version / summary`，业务字段进 `payload`。
- 事件类型**只追加、不复用、不改语义**；新增类型必须同时登记 `catalog.js` 与 schema（测试会校验三处枚举一致）。
- 每个聚合流的 `version` 从 1 连续递增，并发提交用期望版本做乐观并发；跨流写入走原子批次，任何一条校验失败则整批不提交。
- 事件不存联系方式等易失资料；对接待方的资料开放通过带目的、有效期、可撤回的披露事件管理。

## 本地检查

```bash
npm test
```

测试包含：契约漂移检查、事件存储原子性、每条业务规则的正反用例、HTTP 授权矩阵，以及一个 96 名学生 + 5 家接待单位、覆盖临时换车/接待取消/替代同意与拒绝/住宿调整/代签/迟到复核/重复认领的端到端场景。

# HOUZS CENTURY ERP — 稳定性 · 性能 · 正确性 硬化总纲
**CTO 执行规格 (Hardening Master Plan) v1.4**

- **基线 (baseline):** `hello-houzs/Houzs-ERP` @ `main` = `7936ae16`(当前最新;执行时按 §0 铁律再 `git fetch` 刷新为准)，生产域名 `erp.houzscentury.com`
- **当前架构 (已核实):** monorepo v2.0 — `backend/`(Cloudflare Workers + Hono + Drizzle ORM + Supabase/Postgres，正在从 D1 迁移) + `frontend/`(React/Vite + **@tanstack/react-query v5** + mobile PWA)；`vitest`(前后端) + `e2e/`;后端有 `pg_trgm` 全文搜索基建、成套 RBAC migrations。
- **整合来源(本文档已合并三方,无遗漏):** ①**Claude** 对 live 代码的核实 + Hookka 5,273 commits / 336-bug log 实挖(§2.1、§3);②**Codex** 的方案 —— 全库 server 搜索、统一 `<DataTable>`、cursor 分页、`version`/409、幂等 → 已落到 **§1(I4/I5/I6)、WS-B、C2/C3、P0.5**;③**ERPNext / Odoo / Tryton / Dolibarr / metasfresh** 等开源 ERP 的架构教训(§2)。三方冲突处一律以 live 代码核实(P0.2)为准。
- **本文档给谁看:** 执行 agent。每一条 task 是一份可独立落地的工单。**先读第 0、1 节(规则),再读第 4 节(先核实),再按第 5 节 workstream 干活。**
- **重要免责:** live 代码的逐条现状核实(P0.2)由执行 agent 在 Phase 0 完成;凡标注 `[待核实]` 的,必须先用给定方法确认再动手,已修则降级为"验证+补测试"。规则(第 1 节)与 ERP 教训(第 2 节)不受此影响。

---

## 0. 执行 agent 使用须知

> **铁律(最优先):动手前先核实"最新版本"。** 每个 task 先 `git fetch origin` 取**最新** `origin/main`,从它开 worktree,并先核实本文档 `[待核实]` 项在最新代码里的真实状态——已修则降级为"验证+补测试"。**绝不**基于旧 checkout 或本文档假设直接改。(教训:先前审计误用了 2 个月前的过时 fork `weisiang329-eng/houzs-erp`;真相源是 `hello-houzs/Houzs-ERP@main`。)

1. **一 task 一 worktree 一 PR。** 先 `git fetch origin`,再从最新 `origin/main` 开 `git worktree add ../hz-<taskid> -b <type>/<area>-<taskid> origin/main`。绝不两个 agent 改同一批文件。
2. **绿灯才能交:** `npm run typecheck` + 相关 `vitest` + 受影响 `e2e` 全绿;性能类 task 附 before/after 真实数字。
3. **每条 fix 附回归测试。** 没有测试的修复视为未完成。
4. **对照第 1 节不变量自检**,再提 PR,PR 描述引用 task ID + 验收证据。
5. **不改 UI 的样子和用法**(除 WS-B 搜索是刻意升级);前后端截图对比证明外观未变。
6. 标 `[待核实]` 的先核实;核实结论写进 PR。标 `[已核实]` 的是本文档已确认的事实。

**Task 工单模板(每条 task 都按此填):**
```
### <TASK-ID> <标题>
- 目标 / Why:
- 现状 & 证据(file:line 或核实方法):
- ERP 先例(为什么这是坑):
- 做法(分步):
- 涉及文件/区域:
- 正确做法要点(引用不变量 I#):
- 验收标准(可测量):
- 测试(单元/集成/e2e):
- 回滚方式:
- 依赖(前置 task):
```

---

## 0.1 仓库既有约定(来自 repo `CLAUDE.md` —— 执行 agent 必须遵守,违反即踩既定规矩)

- **每修一个 bug 必须写进 `BUG-HISTORY.md`**(症状 → 根因(追出来,非猜)→ 修复 → PR/日期,倒序、带严重度)。owner 硬规则,同一个 PR 内补;动子系统前先读它。→ 并入 **WS-F5 / DoD**。
- **无 emoji**:提交 / 注释 / 文案 / 空状态一律不用 emoji。
- **Drizzle 写新代码**(schema `backend/src/db/schema.ts`,client `getDb(env)`);legacy 原始 SQL 逐路由转,不在同一函数混用两种风格。
- **迁移 = 手写、顺序编号的 `.sql`,部署后不可变**;drizzle-kit 只做类型/diff,**不是** migration runner。→ 影响 **P0.5 / C2 / E2**:version 列用**新的编号迁移**加,绝不改旧迁移。
- **大块 seed / 测试数据不进编号迁移**,用一次性 `backend/scripts/seed-*.mjs`(先例 `backfill-project-codes.mjs`)。→ **P0.4** 的 10 万行数据集用脚本,不用迁移。
- **URL 即状态**:filter/tab/mode 进 `useSearchParams`;localStorage 仅个人偏好 fallback。→ 对齐 **A3 / B2**。
- **权限是扁平字符串**(如 `projects.read`),目录 `backend/src/services/permissions.ts`;either-or 用 `requireAnyPermission([...])`。→ **修正 WS-D:D1 是"每 mutating 路由挂对的扁平权限字符串 + default-deny",不是 module+level。**
- **记录级 scope 已二维**:PIC one-hop + brand allow-list(mig 049),`getProjectScope(user) → {pic_ids, brands}`;手写 SQL 散在 3 处(list/calendar/notifications),集中成 `projectScopeWhere(user)` 已在他们 Roadmap。→ **D2 = 集中/扩展现有 scope,不是从零。**
- **暂无 WebSocket**:realtime 用轮询(见 Obsidian wiki *Polling Strategy*)。
- **改到模块 surface / 数据模型 / 架构决策后,更新 Obsidian wiki**(`mcp__obsidian__*` 工具);纯 bug fix / 重构不用。
- **破坏性操作(force push / drop table / 删分支)先确认**;auto 模式 ≠ 授权。

---

## 1. 全局工程不变量 (The Rules) — 每条 task 都必须遵守

> 这些是从 Hookka 的 336 条 bug、ERPNext/Odoo 十年 issue、以及主流开源 ERP 架构里提炼的硬规则。违反其一即为不合格,无论功能是否"看起来能跑"。

- **I1 服务器是唯一真相源。** `localStorage` / React Query cache / IndexedDB 只能是**缓存**,绝不能是任何业务数据的唯一存储。业务数据丢失=事故。
- **I2 复制存储的字段(snapshot)必须防漂移。** 任何被复制到别处的值(成本、售价、地址、客户名、hub)要么**实时算**,要么**上游一改就级联更新 + 写审计 + 回归测试**。这是 Hookka 头号坑。
- **I3 每个 mutation 五件套:** 校验前置状态 → 检查权限(默认 deny)→ 原子提交(单事务/batch)→ 写 audit before/after → 失败回滚且 UI 不显示假成功。
- **I4 并发防覆盖 —— 版本号是硬性基线(接下来所有可变记录都必须有)。** 每张可变业务表都带 `version INT NOT NULL DEFAULT 1` + `updated_at` + `updated_by`;**所有** update 走条件更新 `... SET version = version + 1, updated_at = now() WHERE id = ? AND version = ?`;`changes = 0` → **409 Conflict**;API 写入必须带 `expectedVersion`(或 `If-Match`),响应体必须回当前 `version`;前端(React Query `onError`)提示"记录已被他人修改 → 重载/比较",**绝不**静默 last-write-wins。D1 与 PG 双套迁移同时加。落地基线见 **P0.5**,消费见 C2/C4/C7。
- **I5 幂等 + 唯一。** 所有 create/POST 接受 `Idempotency-Key` 或有 DB `UNIQUE` 兜底;业务单号由 **DB 侧**生成(sequence/唯一),绝不 app 侧 `max+1`。
- **I6 分页 + 全库搜索。** 列表默认 cursor 分页(默认上限 50–100);搜索永远 **server-side 全库**,再对结果分页;**绝不** client 端只 filter 当前页。
- **I7 生命周期不可乱改。** 已提交/已完成/已取消的业务文档不能用通用 PATCH 改任意字段;用显式 transition command endpoint;取消/退回用 **reversal**,不删历史。
- **I8 权限在每次 DB 读写强制。** 前端隐藏菜单 ≠ 安全;默认 deny;记录级 scope 不只看 module;错误信息不泄露 permission key / 敏感字段(参考已修的 #858)。
- **I9 发布闸门。** CI 必须 `tsc` + `vitest` + `e2e` 全绿才 merge;迁移有状态表、可重放、D1↔PG 语义一致(禁止 `continue-on-error` 带病上线)。
- **I10 性能可证。** 性能改动必须有真实数据规模的 before/after(keystroke→paint、long task、API p95、render 次数),且可回滚。禁止"感觉变快了"。
- **I11 一切皆有版本号 —— 接下来所有更新都必须带版本号(用户硬性要求)。** 三个层面缺一不可:①**数据记录**:每张可变业务表带 `version`,写入条件更新(见 I4 / P0.5);②**代码发布 + 数据库迁移**:每次上线打 **semver tag**,迁移文件顺序编号 + 状态表(见 I9 / E2),变更记入 `CHANGELOG.md`;③**文档/规格**:本计划及任何规格文档每次改动都 bump 版本号 + 底部版本历史。任何未来更新(数据、代码、文档)缺版本号 = 不合格。

---

## 2. 跨 ERP 教训蒸馏 (Why the rules exist)

### 2.1 Hookka ERP(前身,带 commit 证据 —— 已实挖 5,273 commits + 336-bug log)
> **核心事实:Houzs 与 Hookka 无共享 git 历史 → 不继承任何 fix。Hookka 自己审计出 ~120 个问题,当年只修了 8 个(全是钱相关)。** 其余全是 Houzs 从零重现的高风险。

| Hookka 反复踩的坑 | commit 证据 | 对应不变量 |
|---|---|---|
| 快照/级联漂移(头号,170+ commits) | `630d669d`(成本 15× 虚高)、`72cf33d0`(账龄快照失效) | I2 |
| 假成功/静默保存失败 | `b7f5e2a2`、`3ca1863e`、BUG…06-05-003"绿色成功但没存" | I3 |
| 并发后写覆盖(钱) | `85e839ea`(两财务→付款被吞)、`58a1e924`(race-token) | I4 |
| 重复单据 | `50ce287f`(一 DO 开两发票)、E1–E13 缺 UNIQUE | I5 |
| 迁移/部署带病上线 | `c5f73505`(每次部署都挂)、CI `continue-on-error` | I9 |
| 无分页 O(N×M) | `fa88dd8d`(全表 SELECT)、~100 万比较/次 | I6 |
| 搜索只搜当前页 | `787cefff`(Ctrl+K 无视 query 返回最新 5 条) | I6 |
| 改已完成/取消单据 | `6e86b18b`(完成卡还能再扫) | I7 |

### 2.2 ERPNext(pattern 级,非逐条 commit)
- **strict user permissions / deny-by-default:** 角色有 doctype 权限但没配 user permission 时会看到全部记录 → 默认必须 deny(I8)。
- **perf:** 把 `timestamp(posting_date, posting_time)` 表达式查询改成可索引的 `posting_datetime` 字段 + query builder + 确定性排序(I6/I10)。
- **lifecycle:** submit/cancel/amend 后哪些字段可改、cancellation 是否完整反向、copied doc 是否误继承旧关联(I7)。
- **stock:** SO 预留反而挡住同单 Delivery;缺跨文档 reservation chain → ledger 思路(WS-G)。

### 2.3 Odoo(pattern 级)
- record rule 在 create 时依赖尚未建立的关联;computed field 触发高于当前用户权限的读取;用 `sudo()` 后忘记重新限制 → 授权必须在每次读写、含记录级(I8)。
- 批量 read/write、不要在 loop 内查询、O(n²) 改 Map/Set、只为常用 filter 建索引、用 profiler 而非猜(I6/I10)。
- reservation 未按交期优先、未来 MO 未按计划日期重排 → 确定性优先级(WS-G)。

### 2.4 更广的开源 ERP(Tryton / Dolibarr / metasfresh)通用架构原则
- 库存/财务用 **double-entry / append-only ledger**,余额是 **projection** 不是可直接改的字段。
- 文档 **state machine** + posted 文档 **不可变**,更正用 amendment / reversal。
- 这些归入 WS-G(库存/制造前的基础),现在不做,但新表结构要预留。

---

## 3. 当前架构:已核实事实 vs 待核实

**[已核实]**
- monorepo v2.0;backend = CF Workers + Hono + Drizzle + Supabase/Postgres(D1→PG 迁移中,`backend/src/db/migrations`(D1) 与 `migrations-pg`(PG) 双套并存)。
- frontend = React/Vite + **React Query v5**(→ 旧"整数组 useSyncExternalStore store"根因**已消失**,服务器状态由 React Query 缓存/去重/后台刷新)。
- `React.memo` 已用 **21 处**(旧版为 0)。
- **无**行虚拟化依赖(`react-window/react-virtual/virtuoso` 均未见)→ 大表仍全量渲染,**仍是缺口**。
- `localStorage` 出现 **143 处** → 需审计是否有业务数据(见 A3)。
- 后端 `backend/src/db/migrations-pg/0001_search_trgm.sql` → **Postgres 三元组(pg_trgm)搜索基建已存在**。
- 成套 RBAC migrations(`009_roles_fleet`、`047_sales_hierarchy_roles`、`073_role_page_access`、`094_positions`、`040_departments`…)+ 近期 commit "fold …rules into backend capabilities" → **授权体系成熟且在硬化中**。
- `backend/src/middleware`、`backend/src/scm/middleware` 存在 → 有中间件层。
- 团队已有文档:`docs/perf-optimization-plan.md`、`server-snapshot-playbook.md`、`PERMISSION-MATRIX.md`、`api-fetch-hardening-coe.md`、`hookka-technique-parity.md`、`FOUNDATION-PLAN.md`、`scm-scaling-audit.md`、`CODEBASE-MAP.md`、`ARCHITECTURE.md`;根有 `BUG-HISTORY.md`、`MIGRATION-D1-TO-SUPABASE.md`。

**[待核实](Phase 0 必须先做,方法见 P0.2)**
- 全库搜索是否端到端接上 pg_trgm、是否满足 WS-B 的 UX 契约(排序/高亮/原因/防 race)。
- 哪些大表未虚拟化(SO 明细、Sheet Mirror、SCM 列表、Audit、Users)。
- 143 处 `localStorage` 是否含业务数据(vs 纯 UI 偏好/缓存)。
- Drizzle mutation 是否有 `version`/乐观并发;单号是否 DB 侧生成;`UNIQUE`/幂等覆盖。
- capability 中间件是否默认 deny + 记录级 scope 全覆盖;user 改角色是否有"不得授予高于自身"守卫。
- snapshot 级联是否已按 `server-snapshot-playbook.md` 全覆盖。
- CI 是否真的 gate `tsc`+`vitest`+`e2e`(vs 存在脚本但未强制)。

**[v1.3 核实更新 —— 详见 §5.5 模块映射]** 已确认:①`DataTable.tsx`(2003 行)具备 server 排序/分页/sticky/URL/debounce 搜索,**唯缺行虚拟化**;②`GlobalSearch` Cmd+K 已 server 端 + `AbortController` 防 race + 高亮,但每源 6 条/仅 5 源(非全量结果页);③幂等中间件 `backend/src/middleware/idempotency.ts` 已存在(opt-in);④授权 `requirePermission()` 每路由门已存在;⑤**`backend/src/db/schema.pg.ts` 的 version 列 = 0(版本号完全没有 → greenfield 必做)**。**结论:除「行虚拟化」与「版本号」两项为 greenfield 外,其余多为"核实+加固+铺开现有件"。**

---

## 4. Phase 0 — 基线、埋点、核实(阻塞项,约 1 周;先于所有 workstream)

### P0.1 建性能基线 harness
- 目标:把"卡"变成可量化。做法:Chrome Performance trace + React Profiler,脚本化跑最重页面(SO 明细、SCM 列表、Sheet Mirror、Dashboard、Calendar、Mail、Users、mobile 对应页);桌面 + 移动 4×CPU throttle。记录:首次可交互、路由切换、搜索反馈、保存反馈、最大列表行数、long task、API p95、render 次数、localStorage 读写耗时。
- 验收:产出 `docs/perf-baseline-<date>.md`,含每页 before 数字 vs 下方目标表;可重复。

**性能目标表(WS-A/B 验收基准):**

| 场景 | 目标 |
|---|---|
| 列表首次可操作 | ≤ 1.0s(缓存)/ ≤ 2.5s(冷) |
| 路由切换 | ≤ 500ms |
| 搜索首反馈 | ≤ 100ms(输入即变) |
| 搜索结果到达 | ≤ 500ms p95 |
| 保存反馈 | ≤ 150ms 进入 Saving |
| 大列表首屏 render | ≤ 800ms |
| 主线程 long task | 无 > 200ms |
| 假成功(保存失败却显示成功) | 0 |
| 未授权 API 成功 | 0 |
| 旧搜索结果覆盖新结果 | 0 |

### P0.2 现状核实矩阵
- 逐条核实第 3 节 `[待核实]` 项,产出 `docs/current-coverage.md`:每个风险类 = 已修/部分/未修 + file:line 证据。**这是决定后续每条 task 是否要做的开关。**

### P0.3 可观测性埋点(是 WS-E 的一部分,但 P0 先落最小集)
- 每个响应回 `X-Request-ID`;前端记页面加载/API 耗时/long task/failed save/route 时长/设备网络类别;后端记 endpoint/status/duration/rows/bytes/role(非敏感)/request-id。禁记 password/token/PII。
- 验收:用户报"卡"时能凭 request-id 查到完整链路。

### P0.4 大规模测试数据集
- 生成 100k orders / 100k SO lines / 10k SKU / 10k users 的 seed(PG + D1 双库),供 WS-A/B/C 的性能与并发测试。
- 验收:一条命令可重建;记录各列表 API p95、响应体大小、前端 render 时长。

### P0.5 版本号(optimistic-concurrency)基线 —— 先行,是 WS-C 的地基
- **目标:把"版本号"变成接下来全站的标准,不是某个 feature 的附属(用户明确要求:"我们必须要有版本号接下来")。**
- 做法:①盘点所有可变业务表,产出 `docs/version-column-rollout.md`(表 × 是否已有 version × 上线批次);②统一约定 `version INT NOT NULL DEFAULT 1` + `updated_at` + `updated_by`,**D1 与 PG 双套迁移同时加**;③封装 Drizzle 写入 helper(`updateWithVersion`):强制条件更新 + 自增 version + 0 行抛 409;④API 层统一:GET 响应体回 `version`,写入必须带 `expectedVersion`/`If-Match`;⑤前端封装 React Query mutation 的冲突处理(`onError` → 冲突 UI:重载/比较,保留用户输入)。
- 要点:I4。**这是 C2/C4/C7 的前置**——先有版本号地基,后面的并发防覆盖、单号防撞、状态机才稳得住。
- 验收:核心表(SO header/lines、payments、events、SKU、settings、SCM 单据)**全部**有 `version` 且写入强制条件更新;两会话并发改同一记录,后到者稳定得 409、前者不被覆盖;矩阵测试(并发双写→409)进 CI 且为 merge gate。
- 测试:集成(并发双写 → 409)、迁移可重放、helper 单测。回滚:迁移可逆(version 列保留无害)。依赖:P0.4。

---

## 5. Workstreams(工作流)

> 优先级:**WS-A/B(felt lag + 搜索)** 与 **WS-D(授权,你选了完整版)** 与 **WS-C(数据安全)** 并行推进(改不同文件);**WS-E/F** 贯穿全程;**WS-G** 待 A–F 稳定后。

### WS-A 前端性能与响应

**A1 大表行虚拟化 [待核实→大概率要做]**
- 现状:无虚拟化依赖;`React.memo` 已 21 处但大表仍全量渲染。
- 做法:引入 `@tanstack/react-virtual`;抽一个共享 `<VirtualTable>`;**必须保留** sticky header、行内编辑、键盘上下、横向滚动、可变/固定行高、打印/导出走全量数据(不受视口限制)、屏幕阅读器语义。先做 SO 明细,再 SCM 列表 / Sheet Mirror / QMS / Audit / Users。
- 要点:I10。虚拟化不是把 `.map()` 换成 virtual rows 就完;先稳定 row props(见 A2)再虚拟化,否则 memo 无效。
- 验收:任一大表在 P0.4 数据集下,DOM 行数 ≤ 视口+缓冲(约 30);首屏 render ≤ 800ms;滚动无 > 200ms long task;编辑/键盘/打印功能不回归(e2e 覆盖)。
- 测试:e2e(编辑一行、键盘导航、打印导出行数正确);perf budget(DOM 节点数、render 时长)。回滚:组件级,feature flag。依赖:A2。

**A2 稳定 row/cell props + 选择性重渲染 [待核实]**
- 现状:React Query 已消除整store 广播,但列表行的 `columns`/`callbacks`/`ctx`/`cell formatter` 若每次 render 新引用,`React.memo` 仍失效。
- 做法:`useCallback` 事件、`useMemo` columns/ctx、把行组件 `React.memo`;profiler 确认改一行只重渲染该行。
- 验收:profiler 显示单行编辑 → 仅该行 + 汇总重渲染,非全表。测试:Profiler 断言 render 次数。依赖:无。

**A3 localStorage 业务数据审计与迁移 [待核实,143 处]**
- 现状:143 处 `localStorage`。做法:P0 先分类每个 key = 业务数据 / UI 偏好 / 缓存。**业务数据(若有)必须迁到服务器(I1)**;大缓存(若阻塞主线程)`debounce` 或移 IndexedDB;UI 偏好保留。审计首次 `JSON.parse` 大 payload 是否阻塞。
- 验收:`docs/localstorage-audit.md` 列出每 key 分类与去向;无业务数据仅存浏览器;无 > 50ms 同步 localStorage 写在输入热路径。测试:key 分类快照测试。依赖:P0.2。

**A4 搜索/筛选输入不阻塞 [待核实]**
- 现状:多页各自 search。做法:输入用 `useDeferredValue`/`startTransition`;配合 WS-B 的 server 搜索 + AbortController。
- 验收:输入每键 ≤ 1 帧反应;无输入阻塞 long task。依赖:WS-B B2。

**A5 Calendar/聚合热点 [待核实]**
- 现状:旧版有 parseISO storm。做法:核实当前 Calendar/Dashboard 是否在 render 内重复 `new Date`/大聚合;若是,预解析时间戳一次 + `useMemo` 聚合 + 聚合下推后端(见 C/E 的 materialized view,团队已有 `#861` AR aging MV 先例)。
- 验收:目标页无 > 200ms long task。依赖:P0.1。

### WS-B 全库搜索与统一 DataTable(你反复强调的重点)

**B1 确认/补齐后端全库搜索 [待核实,pg_trgm 已存在]**
- 现状:`migrations-pg/0001_search_trgm.sql` 已建三元组索引。做法:核实/实现 `GET /…/search?q=&filters&sort&cursor&limit`:全库 `WHERE`(trigram + 精确)→ **排序按匹配等级** → cursor `LIMIT 51`;覆盖字段:SO no、customer name/code、phone、agent、venue、PO/ref、status、以及 `so_lines` 的 item code/description(用 `EXISTS` 子查询,走索引不全扫)。
- **匹配排序(硬要求):** SO no 精确 > SO no 前缀 > customer code 精确 > customer name 前缀 > phone/ref > item code > 其他 contains。
- 要点:I6。绝不 client 端只 filter 当前页。响应含 `nextCursor`、`total`(或近似)、每条命中的 `matchReason`(命中来自 line item 时返回 `Item · <code> — <desc>`)。
- 验收:P0.4 数据集下 p95 ≤ 500ms;精确单号排第一;命中第 20 页的记录出现在搜索结果第 1 页。测试:集成(排序/字段覆盖/cursor 稳定性)。依赖:P0.4。

**B2 统一 `<DataTable>` 组件**
- 一个组件提供:server 搜索/筛选/排序、cursor 分页(page size 25/50/100)、**行虚拟化(复用 A1)**、请求取消(AbortController)+ 防 race(request seq id / React Query queryKey)、URL 状态同步(`?q=&status=&agent=&cursor=`)、column preferences、loading/empty/error/offline/conflict 五态、移动端视图。
- **搜索 UX 契约(逐条验收,来自已验证的交互原型):**

| 操作 | 应有表现 |
|---|---|
| 输入首字符 | UI 立即进入搜索态(不等 debounce) |
| A → A1 | 旧 query 立即作废,只接受 A1;A 的迟到响应不得覆盖 A1 |
| 目标原在第 20 页 | 仍出现在搜索结果第 1 页(全库) |
| 命中商品行 | 显示命中原因 `Matched item: …` |
| 查询较慢 | 输入不卡,保留旧结果 + 显示 `Searching…` pill |
| 清空搜索 | 恢复原列表的 cursor/filters/sort/scroll |
| 精确单号 | 目标排第一 |
| 无结果 | 显示可点建议,而非空白表 |
| Enter / Esc / ↑↓ | 打开最相关 / 清除 / 移动选择 |

- 要点:I6 + I10。"即时反馈"= 每键即时视觉反馈(输入框/清除键/搜索态/已缓存结果/高亮);网络层 ~80–150ms 协调窗只为省无谓请求,UI 不等待。
- 验收:上表逐条通过(e2e);切页/刷新保留状态;旧结果 0 次覆盖新结果。回滚:组件级。依赖:A1、B1。

**B3 逐页接入 `<DataTable>`**
- 顺序:SO 明细 → Sales Orders → SCM(CN/DO/PO/GRN 等)→ Events/PMS → Sheet Mirror → QMS → Users → Audit Log。每页一 task,一 PR。
- 验收:每页达 P0.1 目标表 + 搜索 UX 契约;旧筛选行为不回归。依赖:B2。

### WS-C 数据安全与正确性(Hookka 踩过又没修的那批)

**C1 消灭假成功 / API fetch 硬化 [对齐 api-fetch-hardening-coe.md]**
- 现状:团队已有 COE 文档。做法:核实所有 mutation 走统一 fetch 包装:检查 `res.ok`、失败回滚乐观更新、明确 `Saving/Saved/Failed/Outdated` 状态、离线标 `Unsynced`、防重复点击。React Query 用 `onError` 回滚 + `invalidateQueries` 重同步。
- 要点:I3。验收:注入 400/500/离线,UI 均不显示假成功、可重试、不丢用户输入。测试:hook 测试(失败回滚)、e2e(断网保存)。依赖:P0.2。

**C2 乐观并发 version + 409**
- 做法:可变核心表加 `version int`(或用 `updated_at`);Drizzle update 用 `WHERE id=? AND version=?` 返回受影响行数;0 行 → 409;前端提示重载/比较。
- 要点:I4。验收:两会话同改一记录,后到者得 409 且不覆盖;e2e 双写测试。依赖:Drizzle schema 迁移(PG + D1 双套)。

**C3 幂等 + UNIQUE**
- 做法:POST 接受 `Idempotency-Key`(存表去重);核心文档/付款表加 `UNIQUE`(单号、invoice_no、(doc, seq) 等);Excel/批量导入安全重试不产生重复。
- 要点:I5。验收:同一 POST 重试两次只落一条;并发批量不产重复单号。测试:集成(重试、并发)。依赖:schema 迁移。

**C4 单号 DB 侧生成**
- 现状:核实是否仍 app 侧 `max+1`。做法:改 DB sequence / 事务内取号 + UNIQUE 兜底。
- 要点:I5。验收:两用户并发开单不撞号、不互相覆盖。依赖:C3。

**C5 多步写入原子化**
- 做法:核实"header + lines + payments"、"user delete + reparent"、"doc delete + cascade" 等是否单事务/`db.batch`;非原子的改原子。
- 要点:I3。验收:中途注入失败不留半保存/孤儿数据;集成测试覆盖。依赖:无。

**C6 快照漂移防护 [对齐 server-snapshot-playbook.md] —— Hookka 头号坑**
- 做法:核实所有 snapshot 字段(cost/price/address/customer name/hub)是否满足 playbook:上游改动 → 级联更新所有镜像 + 写审计 + 回归测试;能实时算的改实时算。列一张"snapshot 字段清单 × 上游源 × 级联是否覆盖"矩阵。
- 要点:I2。验收:改上游后所有下游镜像一致(集成测试逐字段);清单无遗漏。依赖:P0.2。

**C7 文档状态机**
- 做法:为 SO/Event/Delivery/Amendment 定义合法 transition;普通字段编辑与状态变更分离;状态用 command endpoint(`/…/confirm|cancel|complete`),服务端校验前置状态 + 权限 + 审计 + 原子 + 下游联动;已完成/取消默认不可改;取消用 reversal。
- 要点:I7。验收:非法 transition 被拒;取消完整反向不删历史。测试:集成(状态迁移矩阵)。依赖:C5。

**C8 审计 before/after**
- 做法:核实关键 mutation 是否写 audit before/after 快照(团队已有基础);补齐 payments/SO/settings 等缺口;审计写失败不静默吞(至少告警),但不阻塞主流程。
- 要点:I3/I8。验收:每个核心 mutation 有 before/after 审计;审计不泄露敏感字段。依赖:无。

### WS-D 授权 —— 完整后端能力强制(**你已选:完整版,非仅补漏**)

**D1 capability 中间件默认-deny 全审计 [待核实]**
- 做法:核实 `backend/src/middleware` 的能力中间件:是否**默认 deny**、是否每条路由声明所需 capability(module+level)。对全部路由做覆盖矩阵(路由 × 方法 × 所需 capability × 记录 scope),补齐任何"仅登录"的写接口。
- 要点:I8。验收:`docs/route-capability-matrix.md` 全覆盖;无仅登录的写接口。依赖:P0.2。

**D2 记录级 scope 强制**
- 做法:对 events/booth-docs/photos/SO 等,除 module 权限外,强制"该用户是否被分配/属于该记录/该 company"(团队已有 company 隔离分支 `audit/company-data-isolation`,对齐它)。
- 要点:I8。验收:有 module 权限但无记录归属者读不到该记录;跨 company 0 泄露。测试:权限矩阵集成。依赖:D1。

**D3 角色变更提权守卫**
- 做法:user 改 role/position/capability 时,服务端校验目标值合法 + **不得授予高于操作者自身的角色**;删除禁止自删、禁止删更高角色。
- 要点:I8。验收:非 Super Admin 无法把任何人(含自己)提到更高角色;e2e 提权测试全拒。依赖:D1。

**D4 权限矩阵测试**
- 做法:自动化 role × endpoint × method 矩阵测试,断言 401/403/200 期望。
- 验收:矩阵测试进 CI,红了 block merge。依赖:D1–D3。

**D5 错误不泄露 + 统一 401/403/404**
- 做法:对齐已修的 #858,全接口错误信息不含 permission key/敏感字段;统一 401/403/404 行为,避免用响应差异探测记录是否存在。
- 验收:错误响应审查通过;探测测试无信息泄露。依赖:D1。

**D6 会话/JWT 失效 [待核实]**
- 做法:核实停用/删除用户后其会话是否即时失效(旧版是 30 天不可吊销的 JWT)。若仍是纯 JWT,加 server 端会话/版本校验或短 TTL + 刷新。
- 要点:I8。验收:停用用户后其请求即刻 403。依赖:P0.2。

### WS-E 迁移 / 部署硬化 & 可观测

**E1 D1→Supabase/PG 迁移收尾 + 语义对齐 [对齐 MIGRATION-D1-TO-SUPABASE.md]**
- 做法:核实迁移进度;确保 D1 与 PG **语义一致**(Hookka 曾栽在 `MAX(0,x)`、camelCase adapter 折叠丢数据);双套 migrations 保持等价;搜索/聚合用 PG 原生能力(pg_trgm、materialized view)。
- 验收:parity 测试(同输入 D1 vs PG 同输出);迁移可重放。依赖:P0.4。

**E2 迁移状态表 + CI gate(禁 continue-on-error)**
- 做法:迁移有状态表、只跑未应用的、失败即 block(Hookka CI `continue-on-error` 带病上线的教训);禁止只 apply git-added 文件的脆弱策略。
- 要点:I9。验收:CI 迁移步骤失败即红;环境不漂移。依赖:无。

**E3 CI 强制 tsc + vitest + e2e**
- 做法:核实 CI 是否真的 gate(存在脚本 ≠ 强制)。补齐:merge 前必须三者全绿。
- 要点:I9。验收:任一失败 block merge。依赖:WS-F。

**E4 redeploy 白屏 / SW 缓存**
- 做法:对齐已见的 `#868`(bump SW 清 stale shell);确保发新版不白屏、chunk 不 stale。
- 验收:发布后强制刷新拿到新 shell;e2e 冒烟。依赖:无。

**E5 部署冒烟 + canary**
- 做法:部署后自动跑核心流程冒烟 + 关键页 canary(错误率、p95、console error)。
- 验收:冒烟失败自动告警/回滚。依赖:P0.3、WS-F。

**E6 telemetry/error 关联(P0.3 扩展)**
- 做法:前后端指标 + request-id 关联 + 错误上报仪表盘。
- 验收:能按 request-id / 用户 / 时间定位慢与错。依赖:P0.3。

### WS-F 测试与回归网(贯穿)

- **F1 API 集成测试:** 401/403、分页、校验、冲突(409)、幂等重试、畸形输入、记录 scope。
- **F2 hook/数据层测试:** fetch 失败回滚、stale cache、重复请求、并发。
- **F3 UI 性能预算:** 关键页 DOM 行数 / render 时长 / 请求数 / 传输字节 / long task 阈值,进 CI。
- **F4 e2e 核心流程:** 登录→SO→编辑→保存→刷新→数据仍在;Delivery;Field Portal;移动端核心。
- **F5 每 bug 附回归测试**(硬规则 I9)。
- 验收:上述进 CI 且为 merge gate。

### WS-G(P2,未来,A–F 稳定后才做)库存/制造 ledger 基础
- append-only stock movement / reservation / release / consumption / output / adjustment ledger(带 `idempotencyKey`、`reversalOf`、`effectiveAt`);余额是 projection。
- 显式文档状态机;posted 不可变;reversal 不删。
- BOM revision 固定引用 + 循环检测(visited set)+ partial completion;planned/reserved/issued/consumed/produced/rejected/scrap/pending 分开。
- effective timestamp / timezone / backdated 政策。
- **现在只需:新表结构预留这些字段,不实现逻辑。**

---

## 5.5 模块应用映射 (Module Application Map) —— 哪个模块套哪条 task

> **核实 live 代码后的关键事实:共享基建大多已存在**,所以绝大多数模块级工作是"**核实 + 加固 + 铺开现有组件**",不是从零造。真正 greenfield 只有两样:**① 表格行虚拟化(加到现有 DataTable)、② 版本号列(schema 现为 0)**。

### A. 共享基建现状(改这一层 = 全模块受益,最高杠杆)

| 共享件 | 位置 | 现状(已核实) | 该做什么(task) |
|---|---|---|---|
| `<DataTable>` | `frontend/src/components/DataTable.tsx`(**2003 行**) | 已有 server 排序、server 分页、sticky/frozen 列、URL `?search=`、debounce 搜索、列宽/pin。**缺:行虚拟化。** | **A1** 给这一个组件加 `@tanstack/react-virtual`;**A2** 稳定 row/cell props。改它=所有列表页受益。 |
| `<GlobalSearch>` Cmd+K | `frontend/src/components/GlobalSearch.tsx` + `backend/src/routes/search.ts` | 已 server 端、`AbortController` 防 race、高亮、键盘导航。**但**每源仅 6 条、仅 5 源(project/assr/user/sales_order/product)、是"快速跳转"非"全量结果页";company scope 已强制,行级 perm 故意放松(仅元数据)。 | **B1** 扩源(consignment/delivery/purchase/invoice…)+ 加"查看全部结果"跳该模块全量搜索;确认排序/matchReason。 |
| 每模块全量搜索 | DataTable `?search=` → 各 list 路由(如 ServiceCases `/api/assr?search=`) | 走 server。 | **B2/B3** 核实每个 list 路由 `search` 的覆盖字段+排序,套 UX 契约。 |
| `<Pagination>` / `useServerSort` / `useStickyFilters` | `components/Pagination.tsx`、`hooks/` | 已有 server 分页+排序+粘性筛选。 | **B3** 核实每列表页确用 cursor/limit,非全量拉回 client。 |
| 幂等中间件 | `backend/src/middleware/idempotency.ts` | 已存在,opt-in(`Idempotency-Key` 头)、(key,scope) 唯一、409。 | **C3** 核实**已挂到**所有关键 POST(付款/开单/发票);没挂的挂上 + DB `UNIQUE` 兜底。 |
| 授权 | `backend/src/middleware/auth.ts` | 已有 `requirePermission("x.y")` 每路由门+403、`requirePageAccess`、company scope(`companyScope`)。 | **D1** 审计每条 mutating 路由是否都有门(default-deny 矩阵);**D2** 记录级 scope;**D3** 改角色不得提权。 |
| **版本号** | `backend/src/db/schema.pg.ts` | **= 0,全 schema 无 version 列。** | **P0.5 / C2** greenfield,必加(见下每族)。 |

### B. 业务模块族 × 适用 task

> 每族列:代表**页面**(`frontend/src/pages/`)+ **后端路由**(`backend/src/`)+ 适用 task。凡列表页"套 DataTable"即自动继承 A1 虚拟化 + B2 搜索契约。**版本号列(P0.5)对下列所有可变表都要加**,`[高危]` 标 Hookka 实际踩过的高危族。

| 模块族 | 代表页面 | 后端路由 | 适用 task(除通用 P0.5 版本号 / D1 授权 / DataTable) |
|---|---|---|---|
| **销售单 SO** [高危] | `scm-v2/SalesOrder{New,Detail,Maintenance,DetailListing,V2}.tsx`、`MfgSalesOrdersListV2.tsx` | `scm/routes/mfg-sales-orders.ts`、`so-amendments.ts`、`so-mirror.ts`、`scan-so.ts` | **C7** 状态机(draft→confirmed→…)、**C6** 快照(customer/price/cost 落在 SO line)、**C3/C4** 开单幂等+单号 DB 侧、**C2** 并发 409(改单) |
| **寄售 Consignment** [高危] | `ConsignmentNote{s,New,Detail,FromOrder}.tsx`、`ConsignmentOrder*`、`ConsignmentReturn*`、`PurchaseConsignment*` | `scm/routes/consignment-{notes,orders,returns}.ts`、`purchase-consignment-*.ts` | **C3** 重复单据幂等(Hookka `50ce287f`)、**C4** 单号 DB 侧、**C7** 状态机、**C5** 原子 |
| **交货 Delivery** [高危] | `DeliveryOrder{DetailV2,NewV2,FromSo}.tsx`、`DeliveryReturn*`、`DeliveryPlanning{,Regions}.tsx`、`Trips/Drivers/Fleet/LorryCapacity` | `scm/routes/delivery-orders-mfg.ts`、`delivery-returns.ts`、`delivery-planning{,-regions}.ts`、`trips.ts`、`unbilled-deliveries.ts` | **C7** DO 生命周期(Hookka DO 卡死无 CANCELLED)、**C6** 地址快照、**C3** DO→发票防重(Hookka `50ce287f`) |
| **采购 Purchase / GRN** [高危] | `PurchaseOrder*`、`PurchaseInvoice*`、`PurchaseReturn*`、`GoodsReceived*`、`GrnFromPo/GrnNew` | `scm/routes/mfg-purchase-orders.ts`、`purchase-invoices.ts`、`purchase-returns.ts`、`grns.ts` | **C3** GRN/PI 防重(Hookka E1)、**C7** 状态机、**C5** 原子 |
| **销售发票 Invoice** [高危] | `SalesInvoice{New,DetailV2,FromDo,ListV2}.tsx` | `scm/routes/sales-invoices.ts` | **C3+UNIQUE** invoice_no 唯一(Hookka `50ce287f` 一 DO 两发票)、**C6** 快照 |
| **库存 Stock** [高危] | `Inventory.tsx`、`StockAdjustment*`、`StockTake*`、`StockTransfer*`、`StockCard.tsx`、`Warehouse{s,Racks}` | `scm/routes/inventory{,-adjustments}.ts`、`stock-takes.ts`、`stock-transfers.ts`、`warehouse{,-mirror}.ts` | **C5** 原子、**C6** stockQty 真相源(Hookka)、**WS-G** 预留 ledger 字段 |
| **产品/主数据** [高危] | `Products.tsx`、`ProductModel{s,Detail}.tsx`、`Categories/Suppliers/Currencies`、`FabricTracking/Library` | `scm/routes/products.ts`、`product-models.ts`、`mfg-products.ts`、`suppliers.ts`、`fabric-*.ts` | **C6** cost/price 快照漂移(Hookka **头号坑** `630d669d`)——改主数据→级联所有引用 |
| **财务/收款 Finance** [高危·钱] | `PaymentVoucher{s,Detail,New}.tsx`、`Accounting.tsx`、`Outstanding.tsx`、`HrCommission.tsx` | `scm/routes/accounting.ts`、`ar-reconciliation.ts`、`payment-vouchers.ts`、`payment-audit-log.ts`、`scan-payment.ts`、`routes/finance.ts` | **C2 并发 409(钱!Hookka `85e839ea` 付款被吞)**、**C3** 收款幂等、**C5** 原子、**C8** before/after 审计、**C6** AR 账龄(已有 MV `#861`) |
| **制造/MRP** | `Mrp.tsx`、`MfgDeliveryOrdersListV2`、`ProductModels` | `scm/routes/mrp{,-lead-times}.ts`、`mfg-*.ts` | **WS-G**(P2 ledger/BOM);现仅 P0.5 + DataTable |
| **服务/ASSR/QMS** [高危] | `ServiceCases.tsx`、`ServiceLogistics/Metrics/Settings`、`MyCases.tsx`、`ServiceLeadTimePortal` | `routes/assr.ts`、`assrPortal.ts`、`assrFormIntake.ts` | **C7** case 生命周期(Hookka 完成卡可再扫 `6e86b18b`)、**C6** 快照 |
| **项目/PMS/活动** [高危] | `Projects.tsx`、`ProjectMaintenance.tsx`、`Overview.tsx`、`Sales.tsx`、`Announcements` | `routes/projects.ts`、`events.ts`、`sales.ts`、`agent-console.ts` | **D2** 记录级 scope(PIC/brand/company 隔离,对齐 `audit/company-data-isolation`) |
| **管理/用户/权限** [高危] | `Users`(`Team.tsx`)、`Roles.tsx`、`Positions.tsx`、`Settings.tsx`、`SystemHealth` | `routes/users.ts`、`roles.ts`、`positions.ts`、`departments.ts`、`settings.ts`、`companies.ts` | **D3 改角色不得提权(users.ts,最高危)**、**D5** 错误不泄露、**D6** 会话失效、**C8** 审计 |
| **邮件 MailCenter** | `MailCenter/{Compose,Inbox,Thread}.tsx` | `routes/mail-center.ts`、`mail-inbound.ts`、`inbox.ts` | **B3** 分页(Inbox)、授权(已修 `#858` 泄露) |
| **移动端 Mobile** | `mobile/Mobile*.tsx`(已有 `MobileVirtualList.tsx`) | 复用同一批后端路由 | 与桌面同源:**C1/C2** 保存不假成功+版本冲突、**B1** 搜索(`MobileSearch.tsx`);核实 `MobileVirtualList` 覆盖所有长列表 |

### C. 每页/每路由/每表 应用规则(套一次,处处一致 —— 执行 agent 逐页照此办)

- **每个列表页** → 统一走 `<DataTable>`(继承 A1 虚拟化 + B2 搜索契约 + B3 cursor 分页);核实其 list 路由 server 端搜索/排序/分页齐全。
- **每个明细/编辑页** → 保存走 **版本条件更新**(带 `expectedVersion`,冲突弹 409 UI,保留输入);**不假成功**(C1);创建走**幂等**(C3)。
- **每条 mutating 路由** → 必有 `requirePermission(...)`(D1 default-deny)+ company scope + 记录级 scope(D2);改角色查提权(D3)。
- **每张可变表** → 加 `version` + `updated_at` + `updated_by`(P0.5),D1/PG 双套迁移;复制存储的字段(cost/price/address)登记进"快照矩阵"(C6)。
- **每个业务文档** → 已完成/取消不可通用 PATCH 改;状态走 command endpoint(C7);取消用 reversal。

---

## 6. 依赖与排期

```
Phase 0 (阻塞全部,~1 周)
  P0.1 基线  P0.2 现状核实  P0.3 埋点  P0.4 大数据集
        │
        ├──────────────┬───────────────┬──────────────┐
        ▼              ▼               ▼              ▼
  WS-A 前端性能    WS-B 搜索/表     WS-C 数据安全    WS-D 授权(完整)
  A2→A1→A3/A4/A5   B1→B2→B3         C1..C8 并行      D1→D2/D3→D4/D5/D6
        │  (A1 供 B2 虚拟化)  │           │              │
        └──────┬───────────┘           │              │
               ▼                        │              │
        WS-B 依赖 A1 + B1               │              │
                                        ▼              ▼
              WS-E 迁移/部署硬化(可与上并行) · WS-F 测试(贯穿,门槛)
                                        │
                                        ▼
                              WS-G(P2,A–F 稳定后)
```
- **并行安全:** A/B/C/D 改不同层(前端组件 / 前端数据层 / 后端 mutation / 后端 authz),分 worktree 不冲突。
- **关键依赖:** B2 需要 A1(虚拟化)+ B1(搜索 API);A1 需要 A2(稳定 props);WS-E/F 贯穿;所有 task 过 WS-F gate。

---

## 7. 完成的定义(Definition of Done)

**每条 task 的 DoD:** ①满足其验收标准(可测量)②typecheck+vitest+相关 e2e 绿 ③附回归测试 ④性能类附 before/after 真实数字 ⑤对照第 1 节不变量自检 ⑥不改 UI 样子(除 WS-B)⑦PR 引用 task ID + 证据 + 第二模型 review。

**每 workstream 退出标准("做完了要怎样"):**
- WS-A:P0.1 目标表全达标;大表虚拟化;无 > 200ms long task;localStorage 无业务数据。
- WS-B:搜索 UX 契约逐条通过;全库、结果独立分页、0 次 stale 覆盖;关键页接入 `<DataTable>`。
- WS-C:注入失败无假成功;并发 409 不覆盖;重试不重复;snapshot 一致;非法状态迁移被拒;核心 mutation 有审计。
- WS-D:route-capability 矩阵全覆盖、默认 deny、记录级 scope、提权被拒、错误不泄露、会话可失效;矩阵测试进 CI。
- WS-E:D1↔PG parity;迁移可重放 + CI gate;发布不白屏;冒烟/canary 生效;可观测。
- WS-F:F1–F5 进 CI 且为 merge gate。

---

## 8. Agent 执行协议

- **每 task:** `git worktree add ../hz-<taskid> -b <type>/<area>-<taskid> origin/main` → 实现 → `npm run typecheck` + `vitest` + 相关 `e2e` → before/after 证据 → 对照不变量自检 → PR(引用 task ID)→ 第二模型 review → merge。
- **绝不**两 agent 同改一批文件;绝不在 `main` 直接改;绝不 `--no-verify` / 跳 CI。
- **每 PR 小而可回滚**;性能/安全类必附证据;bug 类必附回归测试。
- **不碰 UI 样子和用法**(除 WS-B),前后端截图对比。

---

## 9. 假设与待你确认

1. **`[待核实]` 项**:执行 agent 在 P0.2 逐条核实后,若某项当前 main 已修,则该 task 降级为"验证 + 补测试"。
2. **安全力度**:已确认走 **WS-D 完整后端授权**(非仅补漏)。
3. **搜索范围字段**:B1 列的字段清单需你确认是否遗漏(如 delivery/collection reference、approval code)。
4. **WS-G(库存/制造)**:确认现在只预留表结构、不实现逻辑。
5. **本文档落位**:建议提交为 `docs/HARDENING-MASTERPLAN.md`,作为执行 agent 的单一事实源。

---

## 版本历史(本文档遵循 I11 —— 每次更新都带版本号)

| 版本 | 基线 | 变更 |
|---|---|---|
| **v1.4** | `main@7936ae16` | 读入 repo `CLAUDE.md`,新增 **§0.1 仓库既有约定**(BUG-HISTORY 强制、无 emoji、Drizzle、迁移手写编号不可变、seed 用脚本、权限扁平字符串、`getProjectScope` 已存在、轮询、wiki);据此修正 WS-D(权限=扁平字符串,非 module+level)、D2(集中现有 scope);去除文档内 emoji。 |
| **v1.3** | `main@7936ae16` | 核实 live 代码,新增 **§5.5 模块应用映射**(共享基建现状 + 14 个业务模块族 × 适用 task + 每页应用规则);确认 `DataTable`/`GlobalSearch`/`idempotency`/`requirePermission` 已存在,真正 greenfield 仅「虚拟化 + 版本号」。 |
| **v1.2** | `main@7936ae16` | 加入 **I11 全面版本号政策**(数据/发布/文档);加入"整合来源"声明,确认已合并 Claude 核实 + Codex 方案 + ERP 教训。 |
| **v1.1** | `main@2e73a41b` | 加入 §0 **铁律**(动手前先核实最新版本);**I4 版本号硬性基线**;**P0.5 版本号地基**(先行,C2/C4/C7 前置)。 |
| **v1.0** | `main@2e73a41b` | 初版:不变量 I1–I10、跨 ERP 教训、Phase 0、WS-A…G、排期、DoD、执行协议。 |

**下一版(v1.5)的触发条件:** 执行 agent 完成 Phase 0 (P0.2) 后,把所有 `[待核实]` 项回填为"已修/部分/未修",据此裁剪 workstream。

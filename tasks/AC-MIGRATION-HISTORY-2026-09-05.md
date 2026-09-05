# AutoCount → ERP 数据迁移：全史、Bug 史、与 2026-09-07 上线前的差距

> **给老板的一段话。** 你定的上线日是 **2026-09-07（星期一），Company 1**。
> 这份文件把从 8 月初到今天整个「AutoCount 搬进 ERP」的过程、出过的 bug、
> 和现在的状态，按「已证实 / 大概率 / 不知道」三档摆清楚。
>
> 一句话结论：**单据、日期、库存、状态四样在 8 月 29 日那份账本快照上都对平过
> （证实）。但从 8 月 30 日到今天账本又跑了一个星期，这段的变化还没搬进来，
> 而且现在连账本的新快照都拿不到（sa2 密码不对）。** 快照一到手，整套流程
> 1–2 小时可以跑完；快照不到手，星期一上线就是拿一个星期前的账在开店。
>
> 上线前**需要你亲手做**的只有两件：① 把 `sa2` 的密码写进档案（不要发给我），
> 或者授权走 bcp 那条不用密码的路；② 到时候在 AutoCount 锁权限。其余是我的。

写这份文件时读过的东西：`tasks/HANDOFF-2026-09-05.md`（PR #2991）、
`docs/autocount-migration-record.md`、`docs/autocount-cutover-ledger.md`、
`docs/ac-reimport-2026-08-28-ledger.md`、`docs/ac-resync-runbook.md`、
`docs/cutover-tally-method.md`、`docs/generated/autocount-coverage.md`、
`docs/bugs/` 里 91 篇「AutoCount sync + write-back」+ 4 篇「Cutover + migrated
data」+ 相关的销售/采购/送货 bug、GitHub 上 2026-08-19 之后的约 150 个相关 PR、
以及 12 个检查 workflow 的最近三次 run。**下面每个数字后面都写了出处。**

---

## 1. 时间线：四个阶段

| 阶段 | 日期 | 做了什么 | 记录在哪 |
|---|---|---|---|
| **第一轮初始导入** | 2026-08-05 ~ 08-11 | W0 主数据对齐 → W2 非沙发 SO → W3 未收满 PO → W4 库存开账（**整个割接唯一一次真进货**）→ W5 重铺 FIFO 层 → W6 沙发 SO → W7/W9 SO-linked PO → W10 GR/PI 单号盖章 → W11 行补仓库 → W13 迁移 GR/DO 镜像（**故意零库存流水**）→ W16 单号回归 AutoCount 号 | `docs/autocount-cutover-ledger.md` §2、§2B，每波有 run id |
| **回写建成并打开** | 2026-08-11 ~ 08-18 | 08-11 tunnel 通；08-13 你把 `scm.autocount_writeback` 打开（Company 1）；08-14 第一张 ERP 开的 SO 进账本（HC-SO-2608-001/002）；08-17 六种单据 + cancel 在真账本走通 | `docs/generated/autocount-coverage.md`（唯一权威的覆盖表，CI 生成） |
| **第二轮：清空重导** | 2026-08-28 ~ 08-30 | 你拍板 8 条新口径（SO 整张进、DO 全配、GR→PI 链、先清空再导、测试单永不回流、收货量按行、新货号开法、冻结保持）。08-28 wipe（run 33143464728，删 93+4 行）→ 全部重导 → 08-29 库存**双向**对平归零（run 33256248116：正 0/负 0）→ 你定硬绑定 + 核对协议 → 08-30 ALGO-SUSPECT = 0、全书关系互验 | `docs/ac-reimport-2026-08-28-ledger.md` §0 ~ §4o |
| **收尾修补** | 2026-08-31 ~ 09-05 | 照片管道补回（SO 2,724 + PO 2,565 张，R2 上传 840 key 抽验通过）、行键、删行在账本留 Qty 0 的修复（bug 0633，主机 build 2026-09-03T14:32）、Desc2 保存进 remark（#2941）、338 特制记录不动钱（#2901）、部分出货批次拆分（#2967）、settlement 看得见迁移付款（#2965） | 各 PR + `docs/bugs/06xx` |
| **现在** | 2026-09-05 | PR #2991 handoff：**delta migration 卡在拿不到新快照** | `tasks/HANDOFF-2026-09-05.md` |

第一轮跑了 12 小时、第二轮压到 1–2 小时，教训全部写进 `docs/ac-resync-runbook.md`
（行键/日期/状态出生自带、快照只认内部日期、生成物跟着快照重生成、确认句裸调）。

---

## 2. Bug 史：出过什么错，分七类

仓库 `docs/bugs/` 共 752 篇，其中 **91 篇在「AutoCount sync + write-back」区**，
另有 4 篇「Cutover + migrated data」和散在销售/采购/送货区的迁移相关 bug。
下面不逐篇列，按**错的方式**分类，每类挑最有代表性的，并标「已修 / 未修」。

### 2a. 导入器读错栏位（数据搬错了）
| bug | 什么错 | 状态 |
|---|---|---|
| 0060 §9.1 | export 把 `GrQty` 按单聚合，每行都拿到整单的收货量 → **130 行假超收** | 第二轮改为每行 `PODTL.TransferedQty`，已修 |
| 0060 | 读 `l.DelivDate`，栏位其实叫 `DeliveryDate` → **101 行交期丢失**（同一个 key 改名第二次吃亏） | 已修 |
| 0060 | `Math.round(qty) \|\| 1`：数量 0 被写成 1 | 已修 |
| 0220 | 把 `Desc2` 当成 FurtherDescription，其实是两个栏位（照片在后者） | 已修 |
| 0556 | 导入的 processing date 落进退休的栏位，画面看不到 | #2755 已修 |
| 0559 | 重导丢了 SO 单头 Remark2/3/4、UDF_Note、交期 | #2763 已修 |
| 0624 | 行照片按货号配，同货号第二行没照片 | #2902 已修 |
| 0566 | 余额导入按账本行算差，一格多码在 NEG 模式下**双扣** | #2789 已修，当天归零证明 |

### 2b. 迁移进来的单据「薄了」（该带的没带）
| bug | 什么错 | 状态 |
|---|---|---|
| **0617** | 71 张迁移 DO **全部 RM 0**，开 SI 时预填 0 元 | 写入器已修（#2892）；**修旧数据的 `repair-migrated-do-prices.yml` 一次都没 dispatch 过**（gh run list = 0） |
| **0638** | 迁移 DO 从没跟 SO 对过账，所以 Company 1 **一张 DELIVERED 都没有** | 修复脚本 `repair-so-delivered-from-imported-dos.mjs` 已上 main；PLAN 跑过（run 33883428855）：**61 张里 0 张能升**，60 张真的部分送货、每张差一行 —— 见 §3 服务行假设 |
| 0016 / 0030 | 迁移 DO 行没 `item_group`，DO 侧所有审计都过滤成空集 | 已修 |
| 0043 | 迁移 DO 写入器同一行插两次（18 行/8 张） | 已修 |
| 0636 | 338 行特制没记，因为记了钱会动 | #2901 已修：记进 `specialsRecorded`，不动钱 |
| 0640 | Settlement 匹配看不见 `method=imported` 的迁移付款 | #2965 已修 |
| 0553 | 服务单 SO picker 找不到迁移单的 AutoCount 号 | #2748 已修 |

### 2c. ERP 自己的写路径把迁移值盖掉
| bug | 什么错 | 状态 |
|---|---|---|
| 0035 | 迁移 SO 任何 amendment 一批准就用目录价盖掉 AutoCount 价 | 已修 |
| 0600 | 普通行编辑会重算加价，amendment 路径反而有保护 | 已修 |
| **0639** | 迁移行第一次保存，我们生成的摘要盖掉账本的 Desc2，**再回写到账本** | #2941 已修（Desc2 停进 remark，回写读不到 remark）；量过 14,450 行**损失 0** |
| 0048 | 特制加价有成本没收费 | §12 老板决定 #4 仍开着 |

### 2d. 库存对平
| bug | 什么错 | 状态 |
|---|---|---|
| 0054 | 割接库存导入丢掉所有**负数**行，ERP 永远偏高 | `neg=1` 已修 |
| 0026 | 对账器按 AutoCount ItemGroup 排除沙发，枕头凳子 85 件变假盈余 | 改按 category，已修 |
| 0572 | Company 1 绑定行没收货却从公池点亮（没 PO 也 READY） | #2802 已修，`HARD_BOUND_COMPANY_ID = 1` |
| 0567 | 账本货号 30 字截断，对照表照抄截断串当 ERP 码 | 已修，导入器拒绝括号不平的码 |
| #2967 | 部分出货的割接批次没拆，2,590 件真库存成本为 0 | 09-04 已修 |

### 2e. 回写（ERP → AutoCount）
| bug | 什么错 | 状态 |
|---|---|---|
| 0023 / 0024 | 回写会送**没有行**的单；读了 PO 表根本没有的四个栏位 | 已修 |
| 0606 / 0633 | ERP 删行，账本留一行 Qty 0；主机只在恰好有 keyless 行时才 rebuild | **已修并证实**：host build 2026-09-03T14:32，全书扫描 0 张带 `[ERP-CANCELLED]` |
| 0605 | 行到账本的顺序看 Postgres 心情 | #2871 已修 |
| 0549 / 0536 | PO 仓库超长被 AutoCount 默默丢掉；conversion 送 ERP 自己的仓库码 | 已修 |
| 0534 | 没人看队列，两天断线靠账本少单才发现 | #2695 watchdog 已修 |
| 0393 | `mode=all` 回填把 Worker 打死（39 秒 503） | 改窗口回填，已修 |
| D9 / D10 / D14 | 沙发件号不可逆、沙发不能收成一行；部分 convert 会整单转 | **migration record §12 说未关；handoff 说要对树重验 —— 我没验，UNKNOWN** |

### 2f. 检查器自己错（差异是仪器造的，不是数据）
| bug | 什么错 | 状态 |
|---|---|---|
| 0116 | 三个 parity checker 各错一处 | 已修 |
| **0573** | Remark2 考卷的正则里藏着一个**隐形退格字节**，制造 59 张假「ERP 超前」 | 已修：一致 2,548→2,591 |
| 0634 | 从来没人数过多少迁移单两边行不一致 | #2933 建了 line-order sweep，**从没跑过**（需要登录态） |
| 0104 | 给你看的每个 readiness 数字，人口都跟你比对的画面不一样 | 已修 |

### 2g. 流程和工具陷阱（不是 bug，是会让人白等的坑）
- workflow 带 `target` 的**默认全是 staging**，8-30 一整批 SO apply 落进 staging 白等一轮 —— 每次都要 `-f target=prod`。
- 新 workflow **不能从分支 dispatch**（bug 0637），要先 merge。
- `data/*.gz` 的 mtime 不是证据（git checkout 会改时间），只认档案内部 `exportedAt`。
- `mfg_sales_orders.status` 是 enum，`upper()` 会炸。
- AnyDesk 不转发 Win+R；打字要 12 字一段。
- 主机上的 `setup.json` 指向死掉的 SQL 地址，**不要改**（Inistate 在用）。

---

## 3. 现在对平到哪里（每项都是跑出来的，附 run id）

| 检查 | 最近一次 | 结果 | 对 09-07 够不够 |
|---|---|---|---|
| SO 日期/备注 8 字段 (`check-so-dates-truth`) | 09-04 run 33891579695 | **DIFFER 全 0**，2,750 张 | 证实 —— 但是对 **08-29 快照** |
| 库存归零证明 (`import-ac-stock-balance` dry, neg=1) | **08-29** run 33270520497 | **正 0 / 负 0**，未映射货号 5 | 证实 —— 一个星期前 |
| 收满必亮 (`check-ac-vs-erp-reconcile`) | 09-02 run 33657291770 | success | 同上 |
| Remark2 vs 状态 (`check-remark2-vs-status`) | 08-30 run 33302806018 | **ALGO-SUSPECT 0**；账本超前 110 张全部归因（28 送完 / 22 待 PO / 34 排队缺货 / 21 口径 / 5 其他） | 证实 —— 08-30 |
| 两边关系图 (`check-ac-erp-doc-links`) | 09-04 run 33846531231 | **REFUSED：快照 5.2 天旧** | **红**，等新快照 |
| 回写队列 (`autocount-outbox-health`) | 09-05 run 33946164813 | 开关 ON，sent 28 / failed 1 / 0 outstanding；create/convert/cancel **从没入队** | 证实「没坏」，**未证实「能用」** |
| 字段覆盖 (`check-imported-field-coverage`) | 09-04 run 33887566614 | 沙发拆件 812 行 Desc2 100%；SO 行 AutoCount 键 98.2%（**254 行没键**） | 证实 |
| SO 板真伪 (`check-so-status-truth`) | 09-04 run 33852430695 | Company 1：71 张 DO 全 DELIVERED，61 张 SO 带 DO 却没升 | 证实 |

**老板点名要的「stock 跟 AutoCount tally」有两个工具，读的是两份不同的快照，别混：**
- `import-ac-stock-balance` dry = 手册的归零证明，读 `data/ac-stock-balance.json.gz`（08-29/30 导出），**08-29 读 0/0**。
- `check-stock-vs-autocount` 读的是**另一个档** `data/ac-live-stock-balance.json.gz`（08-28 23:27 导出，**在 08-29 对平之前**）。它 09-02 那次 run（33657280922）报 917 agree / 44 disagree / ERP-only 19 —— **那是拿对平前的快照在比，不是现在的差**。要它有意义，两份快照都得重导。
- handoff 里写的 `reconcile-tally` 是 `backend/scripts/fair-pnl/` 下的 **FAIR 损益**工具，跟库存无关，别去跑。

### 61 张「送了却没升 DELIVERED」的单：假设已在代码里证实结构成立
`backend/src/scm/lib/so-delivery-sync.ts`：
- 第 227 行读 SO 行只排除 `cancelled = false`，**没有排除服务行**；
- 第 152 行 `isSoFullyCovered` 要求**每一行**净送货量 ≥ 订购量；
- 第 340 行的 READY 盖章循环**有** `isServiceLine` 排除。

所以「运费/搬运费这种服务行从来不会出现在 DO 上，导致整张单永远差一行」在
代码上是成立的（PROVEN 结构，**LIKELY** 是这 60 张的原因）。逐行分类的量测在分支
`fix/is-the-short-line-a-service-line`（1 个 commit，+60 行，只加 PLAN 打印），
**还没开 PR**。注意：`git diff origin/main..该分支` 会看到一堆「删除」，那是分支
基点旧，不是它真删了东西；`git log origin/main..分支` 才是它的内容。

---

## 4. 上线前要做的，按顺序（谁做、要多久）

| # | 事 | 谁 | 状态 |
|---|---|---|---|
| 0 | **拿到账本新快照**：A) 你把 `sa2` 密码写进 `AC_CRED_FILE` 那个档；或 B) 我上主机用 bcp（Windows auth，不用密码，AnyDesk 480 732 739 要有人接） | **老板** | **BLOCKED** |
| 1 | 手册阶段 0：三支 exporter → `gen:ac-sofa-corpus` + `gen:ac-item-map` → `test:light` → 一个 PR | 我 | 等 0 |
| 2 | 阶段 1–3：七支导入 workflow + 库存 + 改值刷新 + 照片（全部幂等，dry → 读数 → apply，**每次 `-f target=prod`**） | 我 | 等 0，约 1–2 小时 |
| 3 | 阶段 4 六项全 0（§3 的表重跑一遍）+ 两个库存工具都对新快照读 | 我 | 等 0 |
| 4 | 三支**已写没跑**的修复：a) `repair-migrated-do-prices`（plan → apply，DO 金额）；b) 服务行分支开 PR → merge → dispatch PLAN 读分类；c) 分类若证实是服务行，改 `isSoFullyCovered` 排除服务行（改规则要你点头，这是判断题）；然后 `repair-so-delivered-from-imported-dos` **在 delta 之后**才 apply | 我 + 你点头 4c | 4a、4b 可以现在做，不用等快照 |
| 5 | 254 行没 AutoCount 键的 SO 行：你选了方案 C（找出会卡的，不整批 rebuild）。`ac-keyless-report.mjs` 有报告句子，**还没接上脚本** | 我 | 未开始 |
| 6 | 阶段 5 封关：你在 AutoCount 锁权限 → 再跑一遍 0–4（此时增量很小）→ 回写烟测矩阵（改日期 → proceed → 转 PO → GR → DO → SI，每步开账本看同一行）→ AutoCount 只读 | **老板锁 + 我跑** | 星期一之前 |

**烟测特别盯两件：**「改单回写」和「ERP 开新 PO 回写」（coverage 表里 `edit` 和
`create_po` 两行「run against the live book」都是 **no**）。以及沙发单能不能回写
（D9/D10），handoff 说要对树重验，我这轮没验。

---

## 5. migration record §12 里还挂着的老板决定，哪些跟星期一有关

12 条里跟上线直接有关的 4 条（其余是数据整理，可以上线后做）：

| # | 决定 | 建议 |
|---|---|---|
| 3 | ERP 取消一张已进账本的单，是不是不可逆？（SDK 没有 un-cancel） | 建议：是。唯一不会静默分岔的选项 |
| 4 | 特制加价 ERP 要不要收费？AutoCount 从来没收，都压进议价 | 现在是「有成本、不收费」。上线前定一个方向，否则每张新单利润都少算 |
| 10 | AutoCount 里的实物负数（几个枕头/CH-DC 码，-6 ~ -12） | 建议：上线以 ERP 值为准，差额记盘点差异 |
| 1 | **解冻的 go/no-go** —— 你的原话「解冻我跟你说你才做」 | 星期一你说了才开 |

其他 8 条（fabric 合并、HYDRAULIC、Seat Softer、HC-SO-012949、27 行特制、两张 HELD
沙发、三张 0 元 PO 的沙发件）是数据整理，不挡上线。

---

## 6. 这份文件没做到的（诚实列出）

- **没有**重验 D9/D10/D14 三个回写缺口对不对现在的树 —— UNKNOWN。
- **没有**跑任何 workflow；§3 的数字全是读既有 run 的输出。
- **没有**看 91 篇 sync bug 的每一篇正文，2a–2g 是按标题 + 有读正文的十几篇归的类。
- 没有新快照，任何「现在对不对得上」的问题答案都是「**截至 08-29 对得上**」。

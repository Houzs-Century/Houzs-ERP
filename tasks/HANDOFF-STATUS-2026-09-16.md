# Handoff file-by-file status audit — 2026-09-16

**24 files: 0 fully closed (nothing left) · 12 MOSTLY DONE · 5 PARTIAL · 2 OPEN · 5 SUPERSEDED.**
So 19 files still carry at least one open item; 5 are superseded (work moved on, no action on the file itself).
Status verified against `gh`/tree/prod, not the doc's own claims. Newest handoff first.

| File | Status | Key still-open item(s) — 白话文 | Evidence |
|---|---|---|---|
| HANDOFF-2026-09-15-mrp-stale-demand.md | PARTIAL | 43 张已退出 MRP（本 session 做完）；剩 23 张过期未送货单等老板「留/删」(waiting on owner)；「只算有处理日」闸 + close-stale 结单模拟 (in flight this session)；「122 张为何突然冒出」时间线 (in flight this session) | 本 session；mrp-3mo doc；prod 已核 Track E |
| HANDOFF-autocount-evening-2026-09-15.md | OPEN | PO Doc No 剩 243 行补写、Hookka 挂错账户 A/B/C、付款文字 option A (→ AutoCount session) | → AutoCount session |
| HANDOFF-autocount-completeness-2026-09-15.md | MOSTLY DONE | 905/906 已进账本；开着的是主机 swap、Remark2 大跑、客户收据 OR、割接收货转 PI (→ AutoCount session) | 文档 + → AutoCount session（PR #3996 OR 已开） |
| HANDOFF-exports-import-money-2026-09-15.md | MOSTLY DONE | 各清单汇出/导入/金额 PR 全 merged；SO/DO 逐行汇出（feat/so-do-line-export 无 PR + DO #3972）(in flight this session) | #3967/#3968/#3975 merged；#3972 OPEN |
| HANDOFF-so-save-lock-and-venue-2026-09-15.md | MOSTLY DONE | 连续存档锁 + venue 显示已上线；残留：状态改/草稿弃/amendment 仍拒自己的锁、504 未解 UNKNOWN、HC-SO-2609-071 老板要重存一次 (waiting on owner) | #3977 live (deploy 34976768973)、#3982 live (34977524431) |
| HANDOFF-mobile-desktop-permission-parity-2026-09-14.md | PARTIAL | 手机套用 D3（去掉 7 月手机专属规则）、Sales Order 的 option C 第一期、审计 §5 缺陷 B-6/8/10-14 + B-7 POD (not started) | 9 项 merged (#3831-#3858)；其余 doc only |
| HANDOFF-autocount-option-b-2026-09-14.md | SUPERSEDED | 已被 completeness-2026-09-15 取代（文档自述）；残留归 (→ AutoCount session) | doc 自述 supersede |
| HANDOFF-specials-alignment-2026-09-14.md | PARTIAL | §5 全开：共享库存拒动、HC-SO-012046/013224、4 张沙发 PO、枕头 009981/010170、21 个无向抽屉、他供应商沙发 (not started) | 各 round run id；§5 doc only |
| HANDOFF-2026-09-13-evening.md | MOSTLY DONE | 16 PR + 两次生产事故已还原；开着：staging 钥匙（实测仍 anon）(waiting on external: Cloudflare)、option-pool 拆栏决定 (waiting on owner)、状态图收编进行中 | prod /health rest_role=anon 实测；restore run ids |
| HANDOFF-2026-09-13.md | SUPERSEDED | 与 09-13-evening 同两事故，被其取代；同一批老板待决 | doc 自述 supersede |
| HANDOFF-2026-09-12-foundation-and-rehearsal.md | PARTIAL | 演练场已建 + D1-D15 大多已答；六週地基/补齐计划 G1-G8 大部分未做；staging 钥匙 (waiting on external: Cloudflare) + (not started) | #3703 演练活；G4a 分支；plan doc only |
| HANDOFF-autocount-do-dates-and-relink-2026-09-11.md | MOSTLY DONE | 交期回填已归零；relink sweep 上线但关着、没清掉 5 张沙发 keyless（根因 UNKNOWN）；date-compare 工具还在 main 该删 (→ AutoCount session / dev) | 回填 run 34567236846；compare-ac-erp-dates.mjs 仍在树上 |
| HANDOFF-2026-09-10.md | MOSTLY DONE | 8 PR，回写积压清到 11 张各有下一步；残留「开档存一次」+ 3 张待人判 (→ AutoCount session) | #3485-#3504 merged；残留归 AC session |
| HANDOFF-sofa-supplier-alignment-2026-09-10.md | PARTIAL | 11 张已收货 build + 共享库存要「连库存搬」工具、HC-SO-012046/013224 库存调整、2 张真件差、配件核对、重查 09-10 自读批 (not started) | 09-11 applies VERIFY OK；§6/§10c-e doc only |
| HANDOFF-special-order-text-2026-09-10.md | MOSTLY DONE | A/B/C 大致落地（Sofa Accessories 类已上线、账本文字回填已跑）；9058-Console 合并 UNKNOWN 是否执行 (waiting on owner / UNKNOWN) | #3507 live；fabric_accessory 在 prod；9058 model_code 查无 |
| OWNER-DECISIONS-2026-09-10.md | MOSTLY DONE | 决定 1-7 大多已执行；开着：改单加行无 PO 无警告要修（PR #3959 在做）、历史枕头颜色来源、9058 合并 UNKNOWN (waiting on owner) | #3512/#3526/#3522 merged；#3959 OPEN |
| HANDOFF-2026-09-05.md | SUPERSEDED | 上线前 delta 迁移，已于 09-07 上线；残留服务行分支 / repair-migrated-do-prices 归 (→ AutoCount session) | 上线已过；doc 是 pre-cutover |
| AC-MIGRATION-HISTORY-2026-09-05.md | SUPERSEDED | 迁移全史/bug 史记录档，非任务清单；D9/D10/D14 回写缺口对不对当前树 UNKNOWN | 历史记录 doc；go-live 已过 |
| HANDOFF-2026-09-02.md | MOSTLY DONE | loading-lie/部分送货/慢 三项已上线；残留 338 priced specials（后来已零售价化）、手机 coverage cell 未审 (not started) | #2853-#2867 merged；mobile cells doc only |
| HANDOFF-2026-09-01.md | MOSTLY DONE | venue 丢失/慢页/PO 变体修复都上线；残留 venue master 别名规范化（never run）、慢度上线後量测 (not started) | #2835-#2839 merged (deploy 33426836520) |
| HANDOFF-2026-08-31.md | SUPERSEDED | SO 加行（已上线 add-line handoff）、付款提交、MRP 处理日/陈旧单——都已被 09-15 processing-date gate + 本 session 清理接手 | add-line 已 ship；stale 由本 session 处理 |
| MRP-REDESIGN-2026-09.md | MOSTLY DONE | Tracks A-F 全 merged；Track E 实测已 apply（prod 核）；By-Sales-Order 视图未建 (waiting on owner)；Track F 漏斗范围 + Track D 14 行重算 (waiting on owner / dev) | #3596-#3620 merged；prod 查 HC-PO-010087 已 sofa+linked |
| FAIR-PNL-RENTAL-OPEN.md | OPEN | 租金/搭建未对帐（94 差、100 无来源、约 RM186 万），等会计给确认清单 (waiting on external: accountant) | 07-29 至今；doc only |
| PLAN-sofa-accessories-category.md | MOSTLY DONE | 第 1-4 期已上线（fabric_accessory 类在 prod、#3861 换类可用）；开着：在手无颜色枕头库存要盘点 (waiting on owner) | prod 有 fabric_accessory group |

## Verified DONE (dropped) inside these files, that the docs still framed as open
- Track E MRP PO-line link repair — 实测已 apply（HC-PO-010087 行现为 sofa+linked、HC-PO-010045 stool linked）
- Sales-invoice 加行 — 已 ship（SalesInvoiceAddLine.tsx）
- 交期回填、STAGING_DATABASE_URL 删除、Sofa Accessories 类上线 — 均已完成

## UNKNOWN (could not cheaply verify)
- 9058-Console / 9058-CONSOLE 合并是否执行（今天两个精确 model_code 在 prod 都查无）
- do-dates 的 relink sweep 为何没清掉 5 张沙发 keyless（根因仍未定，疑为沙发一行 vs 逐件）
- foundation 文档 D9/D10/D14 沙发回写缺口对不对当前树

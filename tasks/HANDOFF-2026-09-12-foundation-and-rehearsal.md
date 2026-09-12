# Houzs ERP — Handoff 2026-09-12: foundation audit, staging rehearsal, and the fill-in plan

**给老板的一句话：** 这份文件让任何工程师不用问我、不用看聊天纪录，就能接手。上半部是白话结论和要你决定的清单；下半部是给工程师的证据、编号、路径。

**For the engineer taking over:** everything below is on `main` of `Houzs-Century/Houzs-ERP` or in an open PR; run ids and file paths are the evidence. Read the repo's `CLAUDE.md` first — it is the working agreement and it is enforced by CI (worktree per task, PR only, bug-ledger entry per fix, PROVEN/LIKELY/UNKNOWN labels).

---

## 0. 目前状态（2026-09-12，全部有运行纪录）

| 项目 | 状态 | 证据 |
|---|---|---|
| Staging 跟着 `main` 自动部署 | 活了 | PR #3703；push 触发的 run 34628320098 成功 |
| 演练一红自动开 GitHub issue | 活了 | issue #3707 是它自己开的 |
| 生产资料复制到 staging（电话/email 遮罩） | 成功 | run 34642385228：3,110 SO / 765 PO / 585 GRN / 304 DO / 251 PI / 48 SI；12,324 个值遮罩 |
| Staging 演练 | 7/8 绿 | 最后一条（销售单列表）红，根因已钉死，见下 |
| 三週红灯根因 | PROVEN | staging Worker 的 `SUPABASE_SERVICE_ROLE_KEY` 是 **anon** 钥匙。`/health` 现在回 `rest_role`：staging=`anon`，生产=`service_role` |
| 仓库层级指向生产的 `STAGING_DATABASE_URL` | 已删 | `gh secret list` 仓库层 0 把；Staging 环境那把保留 |
| 视图删除必须带授权回复（bug class H 的闸） | 已上线 | PR #3704，`backend/tests/viewDropCarriesGrantRestore.test.ts` |
| 销售单加行/改行「分类跟 SKU 走」(G4a) | PR 开着 | 分支 `fix/so-add-edit-item-group-follows-sku`（见 §6） |

### 只有帐号持有人能做的两件事
1. **换 staging Worker 的钥匙。** Cloudflare 帐号 `816e4573…` → Workers & Pages → `autocount-sync-api-staging` → Settings → Variables and Secrets → `SUPABASE_SERVICE_ROLE_KEY` → 贴上 Supabase staging 专案 `minnapsemfzjmtvnnvdd` → Settings → API 的 **service_role** 那把。验证：`curl https://autocount-sync-api-staging.houzs-erp.workers.dev/health` 的 `rest_role` 变成 `service_role`；下一次演练 8/8 绿；关 issue #3707。**这把钥匙不可以放进 GitHub Actions**（仓库 CLAUDE.md 明文禁止：仓库是公开的）。
2. （已做）删仓库层级 `STAGING_DATABASE_URL`。

---

## 1. 白话结论（三份报告的精华）

### 1.1 为什么 bug 一直复发
修法有两种。**装了「总闸」的类别没再犯**（08-18 后：日期格式 0 次、jsonb 0 次、表头锁 0 次、迁移撞号 3 次全在 PR 阶段被闸抓住）。**「哪里出事补哪里」的类别一直回来**：引号货品 4 次、布料同根因 5 次（0816→0817→0818→0820 是一条修一次错一次的链）。

822 个 bug 编号里只有 116 个有测试钉住；**375 个 high/critical 没有测试** —— 按仓库自己的规矩「没测试等于没修」，这 375 个随时可能回来。

### 1.2 七个地基缺陷（每条都在源代码里点得出行号，见 §5）
- **G1 主档是快照**：型号存一份写死的允许清单（布/尺寸/脚高/规格/隔间/DIVAN 高，6 维度）。Maintenance 新增的东西进不去。
- **G2 一个事实两个家**：`remark` 同时在栏位和 `variants` JSON；三条写入路径三种规矩，沙发改单会把改行写的备注盖掉。JSON 里还有 13 个规格键同样两个家。
- **G3 栏位不成套**：SO/PO/DO 行上有日期；**GR 和 PI 的行上没有任何日期**。
- **G4 规矩装不满所有门**：分类跟 SKU 走 9 道门有、SO 加行/改行没有（G4a，PR 开着）；带引号货品 76 处读法只有 5 处转义（G4b）。
- **G5 列印两套**：规格行有共用组件（7 支 PDF 用），**拣货单完全不印规格**；沙发组合名只有 SO PDF 完整。
- **G6 手机电脑两套实现**：8 月起 415 次只动电脑、143 两边、37 只动手机；手机行照片只有 SO 有。
- **G7 MRP 是纯计算**：不落地、每次重算、开 DO 前不锁 —— 所以上面每条缺陷都长成「MRP 说缺货」。MRP 引擎和它的稽核脚本是两份实现。
- **G8 功能不成套**：六种单据各长各的（折扣百分比 PO/GR 有、SO/DO/PI/SI 没有；取消审批只有 SO/PO；表头锁 PI/SI 没有；变更纪录只有 SO……）。

---

## 2. 要老板决定的事（每条附建议；未决定的不做）

老板 2026-09-12 已说的：**回退、rewards、发 Email 给对方「可能都不需要」；取消审批「有些地方不需要」。** 下面按此标注。

| # | 问题 | 建议 | 老板决定 |
|---|---|---|---|
| D1 | 沙发型号要不要限制能用哪些布？（现况：79 型号同一份 101 项清单，851 布色只能选 3 个） | 不限制，清空清单 | ☑ **老板 09-12：限制只跟我在 Modular 设的走；系统不准自己加限制**（"之前我明明都没有限制，可是却不能选"） |
| D2 | 六种状态怎么统一？ | 加「阶段」层，不改名 | ☑ **老板 09-12：改名。SO/PO/GR/PI/SI 的「生效」一律叫 SUBMITTED，DRAFT 一致；DO 保留 DRAFT/LOADED/DISPATCHED**。（跟我的建议相反 —— 过渡风险见 §3 状态阶段） |
| D3 | 取消审批扩到哪几张单？ | DO + GR（动库存的）；PI/SI 维持直接取消但留纪录 | ☑ **老板 09-12：不扩。只有 SO 要审批；PO 在 Purchase 直接取消** |
| D4 | 收货单一行一个到货日？ | 要 | ☑ **老板 09-12：要；行交期／行日期六张单全部要有** |
| D5 | 行备注补到哪几张单？ | GR + DO 要；PI/SI 看要不要印 | ☑ **老板 09-12：六张单全部要有（会带过去）** |
| D6 | 折扣百分比补到哪几张单？ | SO、DO、PI、SI 全补（同一个元件） | ☑ **老板 09-12：全补，但不要点选按钮 —— 直接打 `1000` 或 `25%`（by amount / by percentage），前端重新设计要好看** |
| D7 | 手机要开哪几张单的「新建」？ | GR（仓库）+ DO（司机） | ☑ **老板 09-12：不做。只做电脑版**（另要一份「手机看六张单」mockup，基于电脑版对照） |
| D8 | 回退 Revert 扩到 GR/PI/SI？ | 不做（用取消＋重开） | ☑ **老板 09-12：能 Cancel 就能 Reopen，正常就是这样** |
| D9 | 发送 Email 给客户/供应商扩到 SO/DO/SI？ | 先查清现况再议 | ☑ **老板 09-12：暂时先这样。以后：SI 自动发顾客、PO 自动发供应商（都还没打通）** |
| D10 | SO 的 ON_HOLD 状态改成跟其他单一样的旗标？ | 要，排最后 | ☑ **老板 09-12：Hold／下游冻结除 PI、SI 外都要有（PI/SI 是最后一步）；「你说我有 bug，这个点要注意」** |
| D11 | 拣货单规格印多详细？ | 两个版面给老板挑 | ☐（老板 09-12：PDF 版式六张单要一样） |
| D12 | 变更纪录扩到六张单？ | 要 | ☑ **老板 09-12：全部都要有、全部完善** |
| D13 | 销售单要「批量改交期」？ | 要（采购单已有） | ☑ **老板 09-12：保留／要** |
| D14 | 手机行照片补 PO/DO？ | 要 | ☑ **老板 09-12：不做手机版** |
| D15 | PDF 照片：目前只印在 SO、PO、DO（老板 2026-09-11 裁定）；GR/拣货单/发票不印。**FOC 免费品行的照片有没有印，UNKNOWN，要查** | 查完再问 | ☐ |

---

### 2.2 老板 2026-09-12 追加裁定（不在 D 表里的）
- 只做电脑版；手机版 parity 不做。
- 从上游转单的功能要统一；PI/SI/DO/GR 都跟着第一条线（SO/PO）走，先把 SO/PO 弄对，其余从上游带下来。
- 改单只有 SO/PO；其余下游直接编辑。规格只有 SO/PO 可编辑，其余只显示（现况正确）。
- 付款记录：SO 的付款要带到 DO 和 SI；PI 也要看到付款。
- **PI 要两个价钱**：PO 带来的价、供应商填的价；有差异要 checking。
- FOC 免费品、每行指定仓库：六张单全部要有。Stock status：SO 有看到就够。
- 折扣：打字输入 amount 或 %，不点选。
- 分类跟 SKU 走：目前基本没问题（G4a 已做 SO 加行/改行）。

## 2.1 老板定的修复原则（2026-09-12）
> 只要是近期 fix 过的 PR 之后又出问题（不管修过一次、两次、三次），就要**重新做完整性的修复**，不再补丁叠补丁；修复以 **long-term** 为导向 —— 保证完整性，同时往后续伸缩性最强的方向做。

落到做法上就是：每条修复必须（a）找出同一根因的所有出现点（用 grep/枚举证明，不是记忆），（b）把规矩收进一个「总闸」（共用函数／数据库约束／CI 检查），（c）让旧的写法在 CI 合并不进去。§1.1 的数据是这条原则的依据：装了总闸的类别零复发，补丁式的全部回来。

## 3. 六週计划（顺序不能换：先地基，再总闸，再对齐）

| 阶段 | 内容 | 约 |
|---|---|---|
| 0 演练场 | **已完成**（§0） | — |
| 1 地基 | G1 主档规则化（等 D1）· G2 一个事实一个家 · G3 GR 行日期（等 D4） | 2 週 |
| 2 总闸＋补齐 | G4a（PR 开着）· G4b 引号总闸 · P 项补齐（等 D3/D5/D6/D12/D13）· 状态阶段层（等 D2）· G5 列印（等 D11）· G8 对照表闸 | 2.5 週 |
| 3 对齐 | G6 手机（等 D7/D14）· G7 MRP 单一实现 · D10 | 1.5 週 |

每条 PR 的验收（三层证据缺一不可）：数据库 dry-run 笔数→套用后重查；后端测试先红后绿；前端电脑＋手机各一张真实截图。

---

## 4. 六种单据功能对照表（从源代码抓，2026-09-12）

图例：✓ 有 · △ 部分 · ✗ 没有 · — 不适用

**单据层**

| 动作 | SO | PO | GR | DO | PI | SI |
|---|---|---|---|---|---|---|
| 表头栏位锁 | ✓自有 | ✓ | ✓ | ✓ | ✗ | ✗ |
| 暂停 Hold | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| 取消要审批 | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 改单 | ✓ | ✓ | — | — | — | — |
| 回退/Reopen | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ |
| 收付款纪录 | ✓ | — | — | ✓ | △ | ✓ |
| 发送 Email | △待确认 | ✓ | ✗ | △ | ✗ | △待确认 |
| 批量改日期 | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 变更纪录 | ✓ | ✗ | △审计 | ✗ | △审计 | ✗ |

**行层**

| 功能 | SO | PO | GR | DO | PI | SI |
|---|---|---|---|---|---|---|
| 折扣（金额） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 折扣（百分比） | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| 行交期/行日期 | ✓ | ✓ | ✗（无日期栏） | ✓ | ✗（无日期栏） | ✓ |
| 行备注 | ✓ | △ | ✗ | ✗ | ✗ | ✗ |
| 规格可编辑 | ✓ | ✓ | △显示 | △显示 | △显示 | △显示 |
| 分类跟 SKU（新建/加行/改行） | ✓/✗/✗ → PR 中 | ✓/✓/✓ | ✓/✓ | ✓ | — | — |
| 行照片 | ✓ | ✓ | —裁定不加 | ✓ | — | — |
| 免费品 FOC | ✓ | ✗ | ✗ | △显示 | ✗ | △显示 |

**状态集合（源代码）**
- SO：DRAFT · CONFIRMED · IN_PRODUCTION · READY_TO_SHIP · SHIPPED · DELIVERED · INVOICED · CLOSED · ON_HOLD · CANCELLED
- PO：DRAFT · SUBMITTED · PARTIALLY_RECEIVED · RECEIVED · ON_HOLD · CANCELLED
- GR：DRAFT · POSTED · CLOSED · ON_HOLD · CANCELLED
- DO：DRAFT · LOADED · DISPATCHED · IN_TRANSIT · SIGNED · DELIVERED · INVOICED · CANCELLED（暂停是旗标，不是状态）
- PI：DRAFT · POSTED · PARTIALLY_PAID · PAID · ON_HOLD · CANCELLED
- SI：DRAFT · SENT · CANCELLED（无分桶模组、无部分付款、无暂停）

**手机端**：看六种单 ✓；新建只有 SO；改单 SO ✓ PO 看；行照片只有 SO；POD 签收 ✓、GR 零成本确认 ✓。

---

## 5. 给工程师：每条缺陷的位置与证据（基准 `origin/main` 2026-09-12）

- **G1** `backend/src/scm/lib/allowed-options-check.ts:113` `hasRestriction` = 非空即生效；`model.allowed_options.{fabrics,sizes,leg_heights,specials,compartments,divan_heights}`；池子由 `frontend/src/pages/scm-v2/ProductModelDetail.tsx:570` 以 `fabric_library` **行 id** 存入。规模：`docs/bugs/0814`。
- **G2** `mfg_sales_order_items.remark` vs `variants.remark`：create `routes/mfg-sales-orders.ts:4315` 从 variants 取；PATCH 栏位映射 `['remark','remark']` 只写栏位；沙发改单 `remark: (newVariants.remark ?? null)`，`newVariants` 来自 request body → 覆盖成 null。另 13 个键：depth/specials/fabricCode/seatHeight/legHeight/divanHeight/gap/cells/buildKey/special/specialChoices/fabricId/pwpCode。
- **G3** 由 `backend/src` 各表实际 `.select()` 栏位推得（迁移档不含六张主表建表）。`grn_items`、`purchase_invoice_items` 无任何日期栏位。
- **G4a** SO add-item `POST /:docNo/items` 与 PATCH `/:docNo/items/:itemId` 收 `it.itemGroup` 原样 → 修在 `fix/so-add-edit-item-group-follows-sku`（`skuCategoryResolver`，与 PO/GRN/DO 同一规则；钉住测试 `backend/tests/soLineItemGroupFollowsSku.test.ts` 先红后绿）。参照 `docs/bugs/0813`、`0514`。
- **G4b** `grep -rnoE "\.in\(\s*'(code|item_code|fabric_code|base_model)'" backend/src` → 76 处；共用函数 `backend/src/scm/lib/pgrest-in-list.ts` 只在 4 个档案用。`chunkIn` 拿 callback、看不到查询 → 规矩装不到那里，这是结构原因。最危险：`lib/grn-reverse-guard.ts:78`（有 5" 床褥的 GR 永远取消不了）、`lib/do-live-allocator.ts:305`（MRP 看不到 PO）。23 处同时吞错误。参照 `docs/bugs/0780`、`0815`。
- **G5** 共用规格行 `frontend/src/vendor/scm/lib/supplier-doc-data.ts:281 docVariantLine`（7 支 PDF 用）；`packing-list-pdf.ts:214` 只印 `[item_code, description]`；sofa-build：sales-order-pdf 7 / purchase-order-pdf 2 / 其余 0。
- **G6** 前端改动统计：`git log --since=2026-08-01` 按 `pages|components` vs `mobile` 分：415 / 143 / 37。手机行照片 `MobileLinePhotos` 只挂在 `MobileSODetail`。
- **G7** `docs/modules/mrp.md` + `backend/src/scm/routes/mrp.ts`；稽核脚本 `backend/scripts/audit-mrp-pairing.mjs` 是第二份实现。
- **G8** 对照表来源：`docs/generated/route-capability-matrix.csv`（单据层动作）、`DiscountInput` 使用处、各表 `.select()`、`backend/src/scm/shared/document-policy.ts`（表头锁：PO/GRN/DO/CN/PCO/PC_RECEIVE；SO 自有模组；PI/SI 无）、`document-hold-routes.ts`（五张单，SI 不在）、`document-cancel-routes.ts`（SO/PO）、状态分桶模组 `so-tab-statuses / po- grn- do- pi-status-buckets`（SI 无）。

### 演练场（阶段 0）的部件
- `.github/workflows/deploy-staging.yml` — push to `main` 自动部署（#3703）
- `.github/workflows/staging-e2e.yml` — 部署后＋每晚 02:00 MYT；`notify` job 红了开 issue；build-report step 检查 `/health.rest_role`，非 `service_role` 直接红（#3718）
- `.github/workflows/staging-refresh-data.yml` — 生产→staging 资料复制（#3701 #3705 #3709 #3711 #3712）：两个 job 两个环境、跳过 staging 没有的表（6 张：`ac_snapshot_*`、`assr_case_categories`、`table_layouts`、`tmp_sheet_capture` = 没有迁移档的生产表，要处理）、丢掉 setval、遮罩 phone/mobile/email（保留员工登入 email）、重种登入、六张单笔数为 0 就失败
- `.github/workflows/staging-catalog-probe.yml` — 只读目录探针（#3717）
- `backend/src/db/rest-key-claims.ts` + `/health` 的 `rest_role/rest_ref/rest_key_ref`（#3718）
- 迁移 `20260912T0130_scm_regrant_so_payment_totals_view.sql` + 闸 `backend/tests/viewDropCarriesGrantRestore.test.ts`（#3704）
- Ledger：`docs/bugs/0824-the-staging-rehearsal-*.md`（fixed）、`docs/bugs/0824-the-staging-sales-orders-list-*.md`（open，等钥匙）

### 顺手发现、还没处理
- staging 上 `anon`/`authenticated` 角色对 `scm` 的表有 SELECT 权限；生产是否相同 UNKNOWN（没有生产探针）。归租户隔离检讨。
- 生产有 6 张没有迁移档的表（见上）。
- 这个仓库没有「对用完即弃的库先演练还原」的设施 —— 资料复制工作流因此连修四次才通。

---

## 6. 进行中的工作（接手时先看这里）

- 分支 `fix/so-add-edit-item-group-follows-sku`（G4a）：改了 `backend/src/scm/routes/mfg-sales-orders.ts` 三处 + 新测试；PR 编号见 GitHub（若还没开，`gh pr create` 后 `gh pr merge` 进队列）。
- 上一个 session 的 worktree 已全部清理；本机 Claude 记忆档在 `~/.claude/projects/C--Users-User-Desktop/memory/staging-rehearsal-state-2026-09-12.md`（只对本机有效）。

## 7. 接手方式
1. `git worktree add ../houzs-work-worktrees/<slug> -b <type>/<slug> origin/main && npm ci`（backend、frontend 各一次）
2. 每个修复：先写会红的测试 → 改 → 绿 → `node scripts/new-bug.mjs "<title>"` 进 ledger → PR → `gh pr merge` 进队列（带迁移档的不要 auto-merge）→ 看 Deploy 与 Deploy (Staging) 的 run 结论 → 演练绿。
3. 判断题（§2）不要自己决定；可证明的缺陷（§5 有行号的）直接修。

三份原始报告（claude.ai 私有连结，内容已并入本文件）：《三条还在复发的线》、《地基复查：七个结构缺陷》、《交易流程补齐计划》。

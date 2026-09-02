# Module: Consignment 的状态要跟销售链对齐 — 提案（还没动任何东西）

老板 2026-08-22 讲了两句话，这份文件是回应那两句话的**方案**，不是已经做完的事。
到目前为止**一行行为都没有改**：只加了一支唯读的普查脚本，去数正式系统里到底有
多少张单、卡在哪些状态。

> 「你再检查一下所有的 Transaction Workflow，包括 Consignment 这边也是一样。
> Sales Order、Consignment Order、PO 等等，正常来说每个 Status 都应该有 On Hold
> 和 Cancel」

> 「然后 CO=SO，DO=Consignment note。状态等等全部都是要对齐的」

**这两句是他讲的全部。这份文件里其他每一个判断都是提案或问题，不是他的裁示。**
凡是需要他拍板的，都放在 §5，没有替他回答。

---

## 0. 先讲结论（一句话版本）

**资料库那边其实早就对齐了；不对齐的是画面和程式。**

六张 consignment 单据的 status 栏位，用的是跟销售链**同一个** Postgres 型别 ——
Consignment Order 的 status 就是 Sales Order 那一个 `mfg_so_status`，
Consignment Note 的就是 Delivery Order 那一个 `do_status`。所以「Consignment
Order 可不可以 On Hold」这个问题，资料库的答案是**早就可以了**。

真正缺的是三样东西，而且它们的贵法差很多：

| 缺的东西 | 讲白话 | 贵不贵 |
|---|---|---|
| 画面上没有那个字 | 单子列表没有 On Hold 的页签，右键选单里没有 On Hold 这一条 | **便宜** |
| 没有人去按 | 状态存在、API 也收，但全系统没有任何一个按钮会写它 | **便宜** |
| 没有事实去推 | 销售单的「Ready to Ship」「Delivered」是**机器自己算出来的**，consignment 这边没有那台机器 | **贵** |

第三样才是这件事的重点。**把状态「对齐」不是改名字，是要盖会让状态自己动的机器。**
销售单每一个自动状态背后都有一个事实（备货算完了、交货单开了、发票开了）。
Consignment 这边大部分事实**根本不存在**，硬编一个出来是这件事里最糟的结果。

### 这份提案照的规矩：只有三个动作给人按

老板 2026-08-22 在同一天还讲了另一句话，已经写进
`docs/modules/document-status-vocabulary.md` §1b：

> 「它不应该能转到 Mark in Production、Mark Shipped 和 Mark Invoiced ... 按理说不
> 应该允许这样手动去转，否则我们的 transaction workflow 就全乱了」

规矩是：**机器会从某个事实推出来的状态，永远不给人按。剩下能给人按的只有三个 ——
Confirm、Hold、Cancel**，因为这三个不是从任何事实推出来的，是人的决定。

**这条规矩直接决定了这份提案长什么样。** 所以下面 §4 的工作清单里，你不会看到
「帮 Consignment Order 加一个 Mark Shipped 按钮」这种东西 —— 那正好是被禁掉的做法。
要嘛把那台推算的机器盖起来（贵，第 3 层），要嘛那个状态就先空着。

> **一个必须讲出来、不能顺手抹平的矛盾。** §1b 那张表把 `IN_PRODUCTION` 说成是
> `so-processing-date.ts` 从 processing date 推出来的、把 `SHIPPED` 说成是
> `so-delivery-sync.ts` 从交货单推出来的。**照今天树上的程式，这两句都不成立：**
> `so-processing-date.ts` 里 `IN_PRODUCTION` 只出现在注解，没有任何一行写它；
> `so-delivery-sync.ts` 里 `SHIPPED` 只出现在一个「可以从哪些状态往前走」的读取清单
> 里，也没有任何一行写它。实际情形是**人按 IN_PRODUCTION 的时候，同一个动作顺便把
> processing date 盖上去**（`mfg-sales-orders.ts` 的状态 PATCH），方向跟 §1b 讲的相反；
> 而 `SHIPPED` 今天**没有任何东西会自动写**（`docs/modules/sales-order.md` §0.1 也是
> 这样写的）。
>
> **规矩本身没有因此变错** —— 不给人手动去动一个跟事实绑在一起的状态，理由完全成立。
> 错的是那张表把「应该由机器写」讲成了「已经由机器写」。这里只记录，不动手改别人
> 刚合并的文件；这是 PROVEN 的观察，处理方式请老板决定。
> （PROVEN：grep `so-processing-date.ts` 与 `so-delivery-sync.ts` 全档。）

---

## 0b. 寄售单的类别也由 SKU 决定（2026-08-22）

跟销售链对齐的不只是状态。寄售单的行也有 `item_group`，而它**不是标签，是决定货
放进哪一个库存格子的输入** —— `computeVariantKey` 只有在类别是沙发或床架时才把
布色 / 座位 / 脚高组进钥匙，类别空掉就只用料号，货进「没分类」那个桶，任何一张
沙发订单都拿不到。

`consignment-orders.ts` 的两条写入路径（建立、加行）原本都存
`it.itemGroup ?? 'others'` —— 也就是浏览器送什么就存什么，而 `'others'` 正是让
规格被完全忽略的那个值。两条现在都从 `mfg_products.category` 用料号解析，走
`lib/sku-category.ts`，按公司范围（两间公司各有 SKU 主档）。`description2` 从
**同一个**解析出来的值去组，所以印出来的字和库存钥匙不可能各说各话。

销售单、采购单、收货单是同一天用同一支模组修的 —— 这就是「跟销售链对齐」在资料层
的意思：同一个概念，同一条规则，六张单一致。追溯：
`docs/bugs/0514-the-so-to-po-hop-lost-the-category-so-received-sofa-stock-wa.md`。

**寄售单（Consignment Note）和寄售退货（Consignment Return）2026-08-23 补上（出货那半边）。**
上面那段修的是寄售**订单**。真正搬库存的是这两张：寄售单写 OUT（货送去展厅），
寄售退货写 IN（货回来），而两张的 `variant_key` 都是从行上**存下来的**
`item_group` 组出来的 —— 所以客户端送错类别，货就搬错格子。建立、加行、以及行的
PATCH（只在这次请求有带 `itemGroup` 或 `itemCode` 时）三条路径现在都先用
`resolveItemGroups`（`lib/sku-category.ts`）把类别改成 SKU 的。从来源单转过来的
路径不动 —— 它抄的是资料库的行，本来就是对的。

**只挡新的行，不修旧的。** 已经存在、类别跟 SKU 不一致的行不在这个 PR 里处理，
要先等只读普查（PR #2671）数出来有多少张。追溯：
`docs/bugs/0524-the-delivery-order-let-the-client-decide-which-stock-bucket.md`。

## 1. 这六张单到底是什么，各自对到销售链的哪一张

老板讲的 CO 和 CN 是其中两张。系统里其实有**六**张 consignment 单据，分成
「卖出去」和「买进来」两条链。

### 卖出去那条（客户那边）

| 单据 | 白话讲这是什么 | 对到哪一张 | 资料表 |
|---|---|---|---|
| **Consignment Order（CO）** | 客户要寄卖的货的订单。跟销售订单一模一样的表，只是货的所有权还没转 | **Sales Order** | `consignment_sales_orders` |
| **Consignment Note（CN）** | 货真的送出去了的那张单。开出来的当下货就出门了 | **Delivery Order** | `consignment_delivery_orders` |
| **Consignment Return（CR）** | 寄卖的货收回来 | **Delivery Return** | `consignment_delivery_returns` |

老板讲的「CO=SO，DO=Consignment note」跟系统本来的设计是一致的 —— 这三张表本来
就是照 `mfg_sales_orders` / `delivery_orders` / `delivery_returns` **一比一 clone**
出来的，连栏位名字都对得上。（PROVEN：
`backend/scripts/scm-schema/consignment/` 里的 consignment module DDL —— 档头写明是
clone，并列出每一个来源表。**注意这支不在 migration 树里**，它是重建 schema 用的
脚本，编号跟 `backend/src/db/migrations-pg/` 的编号不是同一套。）

**跟销售链最大的一个差别：consignment 这条链没有发票。** clone 当时就把
`sales_invoice_id` 拿掉了，理由写在同一个档头。所以销售订单的 `INVOICED` 状态，
在 consignment 这边**没有对应的事实可以指**。这是 §5 的第一个问题。

**寄卖出货不是卖断。** CN 出货走的是「价值中性的移库」，不认成本、不认毛利 ——
东西只是换了地方放，所有权没变。（PROVEN：同一份 DDL 档头的 STOCK MOVEMENT 段。）

### 买进来那条（供应商那边）

| 单据 | 白话讲这是什么 | 对到哪一张 | 资料表 |
|---|---|---|---|
| **PC Order（PCO）** | 向供应商叫寄卖货的订单 —— 货放我们仓，但还是供应商的 | **Purchase Order** | `purchase_consignment_orders` |
| **PC Receive（PCR）** | 供应商的寄卖货到仓了 | **GRN（收货单）** | `purchase_consignment_receives` |
| **PC Return（PCT）** | 寄卖货退回给供应商 | **Purchase Return** | `purchase_consignment_returns` |

（PROVEN：三支 route 的档头各自写明 clone 自哪一支；
`backend/src/db/migrations-pg/0090_scm_purchase_consignment_tables.sql` 建表。）

**这三张跟卖出去那三张不是同一件事，请不要混着讲。** PCO/PCR/PCT 是**我们跟供应商**
之间的寄卖；CO/CN/CR 是**我们跟客户**之间的寄卖。老板讲的「CO=SO、DO=Consignment
note」只讲了卖出去那条链；买进来那条链他没有点名，但他讲「每个 Status 都应该有 On
Hold 和 Cancel」时用的是「所有的 Transaction Workflow」，所以这份提案把六张都列进来
，让他自己决定要做几张。

---

## 2. 状态一条一条对照

看法：**「有没有」那一栏问的是「今天有没有东西会把这个状态写进去」**，不是
「资料库允不允许」。资料库允不允许另外一栏讲。

### 2.1 Sales Order vs Consignment Order

`consignment_sales_orders.status` 的型别就是 `mfg_so_status` —— **销售订单自己那一个
型别**。（PROVEN：上面那支 consignment module DDL 的 ENUMS 段与 status 栏位
宣告。**LIVE 值域要等普查跑完才算证实**，理由见 §2.4。）

| SO 的状态 | 白话 | CO 资料库收不收 | CO 今天有没有人写 | 要自动写的话，机器要读哪个事实 |
|---|---|---|---|---|
| `DRAFT` | 还没写好 | **收**（enum 有这个值） | **没有**。CO 一开单就是 CONFIRMED，程式里写死的 | 不用推 —— 开单时人自己选存不存草稿 |
| `CONFIRMED` | 单子是真的 | 收 | **有** —— 开单当下写进去 | — |
| `IN_PRODUCTION` | 已 proceed | **收** | **没有** | SO 这一格今天是**人按的，而且按下去会顺便盖上 processing date**。照 §1b 的规矩，它不该给人按 —— 所以 CO 这一格的正解是「等有机器从 processing date 推」，不是加一个按钮 |
| `READY_TO_SHIP` | 货备好了，可以叫客人 | **收** | **没有** | **没有这个事实。** SO 靠 `so-stock-allocation.ts` 算备货，那支程式**完全不认识** consignment 表（PROVEN：全档只有一句注解提到 consignment，没有任何一行读写 `consignment_sales_orders`） |
| `SHIPPED` | 货出门了 | **收** | **没有** | **SO 这一格今天没有任何东西会写**（PROVEN，见上面那个矛盾框）。而且 SHIPPED 已经不是 SO 的页签了 —— 老板 2026-08-22:「Sales Order 的 Shipped 跟 Delivered 是合起来的」，它折进 Delivered（`backend/src/scm/lib/so-tab-statuses.ts`）。CO 要对齐就跟着折 |
| `DELIVERED` | 客人收到了 | **收** | **没有** | **事实在，机器不在。** SO 靠 `so-delivery-sync.ts` 从交货单的覆盖量推。对 CO 来说对应的事实是 `consignment_delivery_order_items.consignment_so_item_id`（CN 的行连回 CO 的行）—— **栏位存在**，但 `so-delivery-sync.ts` 里 consignment 出现 **0 次**（PROVEN，grep），所以没有任何东西在算 |
| `INVOICED` | 开发票了 | **收** | **没有** | **没有这个事实，而且不是没写而是不存在** —— consignment 这条链根本没有发票单据（§1） |
| `ON_HOLD` | 暂停 | **收** | **没有** | 不用推 —— 这是 §1b 三个可以给人按的其中一个 |
| `CANCELLED` | 作废 | 收 | **有** —— 列表右键「Cancel Order」 | — |

（CO 今天有没有人写：PROVEN，读 `backend/src/scm/routes/consignment-orders.ts` 的
建立与 `PATCH /:docNo/status` 两条路径，加上
`frontend/src/pages/scm-v2/ConsignmentOrders.tsx` 的右键选单。）

**三个必须一起看的发现：**

1. **CO 的状态 API 什么字都收。** `PATCH /:docNo/status` 把送进来的字串转大写就直接
   写进去，**没有任何合法值清单、没有转换规则表**。挡下不合法值的只有 Postgres 的
   enum 本身。所以今天用 API 就可以把一张 CO 设成 `ON_HOLD` —— 只是**画面上没有任何
   地方按得到**。（PROVEN：`consignment-orders.ts` 的
   `patchConsignmentOrderStatusHandler`。相同的洞在 `consignment-notes.ts` 和
   `consignment-returns.ts` 也有，而且那两支的注解自己写着「这要写成建议，不在这里
   顺手做」。）
2. **CO 的列表其实早就会显示全部九个状态的中文名。**
   `ConsignmentOrders.tsx` 的 `STATUS_LABEL` 九个状态都有，包含 `ON_HOLD → 'On Hold'`。
   缺的只是**页签**（列表完全没有状态页签）和**选单里那一条**。
   （PROVEN：该档 `STATUS_LABEL` 与该档没有 `STATUS_CHIPS`。）
3. **CO 的取消不是最终的，SO 的是。** SO 有 `so_cancelled_final` 会挡住复活；CO 的
   状态 handler 没有这道关，列表还有一条「Reopen SO」写回 `CONFIRMED`。这是一个真实
   的不对齐，而且方向跟老板要的相反 —— 他要的是对齐，这里是 CO 比 SO 松。
   （PROVEN：grep `cancelled_final` 在 `consignment-orders.ts` 里 0 次，在
   `mfg-sales-orders.ts` 里有。）

### 2.2 Delivery Order vs Consignment Note

`consignment_delivery_orders.status` 的型别就是 `do_status` —— **交货单自己那一个**。

| DO 的状态 | 白话 | CN 资料库收不收 | CN 今天有没有人写 | 要自动写的话，机器要读哪个事实 |
|---|---|---|---|---|
| `DRAFT` | 还没确认 | 收 | **没有** | 人的动作（Confirm 的前一格） |
| `LOADED` | 装车了（DO 的「确认」那一格） | 收 | **有，但只有「Reopen」会写**。开单不会经过这一格 | 人的动作 —— 这就是 §1b 的 Confirm |
| `DISPATCHED` | 货出门了（**第一次进这格就扣库存**）。**2026-08-26 起画面上写「Loaded」不再写「Shipped」**（老板：「dispatch就是出发了啊?」—— 三次扫码里这一步是货刚上罗里，开走是下一步 `IN_TRANSIT`）。存进去的值一个字没改 | 收 | **有** —— **开单当下就写**。CN 一开出来货就算出门了 | 人的动作 |
| `IN_TRANSIT` | 在路上 | 收 | **没有** | DO 那边是手机上司机按的 —— 事实是司机的动作，不是推算 |
| `SIGNED` | 客人签收了 | 收 | **没有**（`signed_at` 栏位在，没人写） | 事实是签收证据（POD）。CN 的列印**刻意不放**那个扫码 QR，怕改到真正的交货单状态（PROVEN：`docs/modules/delivery-order.md` 的 loading QR 段） |
| `DELIVERED` | 送到了 | 收 | **没有** | DO 那边靠 POD（签收证据）。CN 没有 POD 入口 |
| `INVOICED` | 开发票了 | 收 | **没有** | **没有这个事实** —— consignment 没有发票 |
| `ON_HOLD` | 暂停 | **不收，也不需要收 —— Hold 自 mig `0324` 起是 `on_hold` 这个栏位，不是状态** | 交货单已经有了（mig `0324`），CN 还没有 | 加同样四个栏位即可，不用动 enum |
| `CANCELLED` | 作废（**会把库存退回来**） | 收 | **有** | — |

**这里有一个 CN 特有、而且是真的业务差异：CN 没有「确认」这一格。**
交货单是先 `LOADED`（单子成立、货还没走）再 `DISPATCHED`（货出门、扣库存）；
CN 是**一开单就 `DISPATCHED`**，程式注解写得很直白：寄卖的货开单当下就出门了。
所以「CN 要不要补一个 LOADED 的确认步骤」是一个业务问题，不是改个字的问题 ——
补了就等于改变「什么时候扣库存」。→ §5。

> **这一段已经作废（2026-08-22，mig `0324`）。** 原文是：「`ON_HOLD` 在这里是真的
> 要动资料库 …… DO 和 CN 会一起需要一支新的 migration 去加这个值。」
>
> **不用了，而且反过来才是对的。** Hold 已经从「状态」变成「状态旁边的记号」——
> 五张单据各加四个栏位（`on_hold` / `hold_reason` / `held_at` / `held_by`），
> `status` 完全不动。交货单就是这样拿到它的第一个 Hold 的，**`do_status` 一个字
> 都没有改**。所以 CN 要 Hold 也一样不用碰 enum：加同样四个栏位就好。
>
> 这件事顺便回答了这份文件后面反复出现的那个成本问题 —— 「加一个状态要付一次永远
> 收不回的资料库改动」。**Hold 不用付了。** Cancel 还是要（那是真的状态）。
> 详见 `docs/modules/document-status-vocabulary.md` 那一节，和
> `docs/bugs/0516-putting-an-order-on-hold-destroyed-its-progress-and-taking-i.md`。

**`ON_HOLD` 这个 enum 值在 `do_status` 里确实没有，而且不需要有。**（PROVEN：加
`ON_HOLD` 的三支 migration 是 `0318`（PO）、`0319`（GRN）、`0320`（Purchase
Invoice）；`do_status` 不在里面 —— 现在也不会进去。）

### 2.3 另外四组，简表

| 这一组 | 资料库型别 | 一样吗 | `ON_HOLD` | 缺得最明显的 |
|---|---|---|---|---|
| Delivery Return vs **CR** | `delivery_return_status` | **同一个** | **两边都没有** | 画面上有 `REFUNDED` 的页签，但**全系统没有任何按钮写得进去** |
| Purchase Order vs **PCO** | `po_status` | **同一个** | **PO 有（mig `0318`），PCO 没得按** | PCO 连个状态选单都没有，只有 Cancel |
| GRN vs **PCR** | `grn_status` | **同一个** | **GRN 有（mig `0319`），PCR 没得按** | 有 `CLOSED` 页签，但没有任何东西写 `CLOSED` |
| Purchase Return vs **PCT** | `purchase_return_status` | **同一个** | **两边都没有** | 有 `COMPLETED` 页签，桌机没有「Mark Completed」按钮 |

**买进来那条链有一个会咬人的地方，值得单独讲：** `po_status` 因为 mig `0318` 已经有
`ON_HOLD` 了，所以 PCO 的栏位**现在就收**这个值 —— 但 PC Receive 每次过帐都会
重算 PCO 的状态，而它只跳过 `CANCELLED`，**不跳过 `ON_HOLD`**。也就是说，如果现在
硬把一张 PCO 设成 On Hold，下一次收货就会把这个 hold **默默盖掉**。PO 那边加 hold
的时候有处理这件事，PC 这条线没有。（PROVEN：`purchase-consignment-receives.ts` 的
`recomputePcoReceived`，唯一的排除条件是 `.neq('status','CANCELLED')`；对照 mig
`0318` 的档头说明。）这是一个**真的 bug 等在那里**，不是风格问题。

### 2.4 为什么上面每一格都还要等普查

上面「资料库收不收」全部是**读 DDL 档案**得到的。这个 repo 自己的
`backend/scripts/scm-schema/README.md` 记着：**DDL 被人手直接改上正式系统超过一次**
（`DRAFT` 这个值就是这样进 `mfg_so_status` 的，两棵 SQL 树里都找不到它）。
**读档案不是关于正式系统的证据。**

所以这份提案附带一支唯读普查：`backend/scripts/check-consignment-status-census.mjs`
＋ `.github/workflows/consignment-status-census.yml`（Actions →
**Consignment status census (read-only)** → Run workflow）。它读三件事：

1. 每一个 status 栏位**活着的** enum 值域（读 `pg_enum`，不是读档案）；
2. 六张单各自有多少笔、卡在哪些状态、分公司；
3. 上面每一个「要读哪个事实」的栏位，实际上有几笔真的有值 —— **数字是 0 就代表那个
   栏位虽然在、但没人填，靠它推出来的状态永远不会跳。**

**这支脚本只印数量、表名、栏位型别和状态名称。** 不印任何单号、客户、供应商、人名、
金额、日期 —— 这个 repo 是公开的，Actions log 也是公开的。

> **状态：UNTESTED。** 这支 workflow 到本文写完为止**一次都还没跑过**，因为
> `workflow_dispatch` 只能从预设分支触发，而这个分支还没合并（实测：
> `gh workflow run` 回 `HTTP 404: workflow ... not found on the default branch`）。
> 合并之后必须先跑一次并确认成功，才算真的交付 —— 这是 CLAUDE.md 明写的规矩。
> **在那之前，§2 每一格的「资料库收不收」都只是 LIKELY，不是 PROVEN；每一张单有多少
> 笔资料是 UNKNOWN。**

---

## 3. 真的缺的，跟只是名字不一样的

这一节是要回答一个很实际的问题：**有些东西看起来缺，其实只是换了个名字。**

### 3.1 其实早就有，只是没露出来（改这些不用碰资料库）

| 看起来缺 | 其实 |
|---|---|
| CO 不能 On Hold | 栏位收、API 收。**只缺画面上一个按钮**（PROVEN，§2.1） |
| CO 不能 In Production / Shipped / Invoiced | 同上，三个都是一样的情况 |
| CO 列表看不出状态 | 列表**早就会画**九个状态的名字，只是**没有页签**可以筛 |
| PCO / PCR 不能 On Hold | `po_status` 和 `grn_status` **已经有这个值了**（mig `0318` / `0319`）。缺的是按钮 —— 外加 §2.3 那个会被盖掉的 bug |
| CN 的「确认」叫 LOADED 不叫 CONFIRMED | 这是**已经统一过的显示规则**：`LOADED` 画面上就读「Confirmed」。这不是不对齐（见 `docs/modules/document-status-vocabulary.md` §1） |

### 3.2 真的缺，而且缺的是「事实」不是「名字」

| 真的缺 | 缺的是什么 |
|---|---|
| CO 的 `READY_TO_SHIP` | 没有备货引擎认得 consignment。要做就是**新写一套备货计算**，或让现有那套多认一张表 |
| CO 的 `DELIVERED` | 连结栏位有（`consignment_so_item_id`），**算的人没有**。要做就是新写一支 CN→CO 的覆盖量同步 |
| CO / CN 的 `INVOICED` | consignment 链**没有发票单据**。这不是补程式，是要先决定寄卖到底怎么收钱 → §5 |
| CN 的 `SIGNED` | 没有签收证据的入口（CN 的列印刻意不放那个 QR） |
| CN / CR / DO / DR 的 `ON_HOLD` | enum 里根本没有这个值，要一支新 migration |
| 六张单全部都没有转换规则表 | SO 有 `so-lifecycle-guards.ts` 管什么状态能跳到什么状态；**六张 consignment 单一支都没有**，PATCH 收到什么写什么 |

### 3.3 顺手会发现的三个现有毛病（不是这次要求的，但就在旁边）

1. **页签写着一个没人写得进去的状态。** CR 有 `REFUNDED` 页签、PCR 有 `CLOSED` 页签、
   PCT 有 `COMPLETED` 页签 —— 桌机都没有对应的按钮。使用者会以为是自己没找到。
2. **同一张单，列表和内页用两套字典。** CN、CR、PCT 三张单的列表各自抄了一份自己的
   状态名字表，内页却读共用的那一份。今天字面上还一样，但**没有任何东西挡住它们分家**。
   `frontend/src/vendor/scm/lib/status-pill.ts` 里根本没有 consignment 这个类别。
3. **CO 在手机上的状态筛选是死的。** 手机版 CO 的筛选片是 `open` / `partial` /
   `closed` / `cancelled`，而 CO 真正的状态是 `CONFIRMED` / `IN_PRODUCTION` / …
   —— 除了 `closed` 和 `cancelled`，其他两个永远筛不到东西。（LIKELY：读程式的比对
   逻辑推得，没有实际在手机上点过。）

---

## 4. 工作要做多少、照什么顺序

分成三层：**便宜**（只动画面、不动资料、不动库存）、**中等**（要动资料库或要补规则）、
**贵**（要盖新的推算机器）。每一层里面再排顺序。

### 第 1 层 — 便宜（估：1～2 天，风险低，随时可以停）

做完这一层，老板讲的「每个 Status 都应该有 On Hold 和 Cancel」**在卖出去那条链上就
成立了**，而且完全不用碰资料库。

| # | 做什么 | 动到哪里 | 为什么便宜 |
|---|---|---|---|
| 1 | CO 的右键选单补上 `Put On Hold` / `Take Off Hold`，照 SO 的选单排 | `ConsignmentOrders.tsx`，参考 `row-menus.ts` | enum 收、API 收、列表早就会画名字 |
| 2 | CO 列表补状态页签 | 同上，参考 `so-list-status.ts` 与 `backend/src/scm/lib/so-tab-statuses.ts` | 纯前端。**要跟着 SO 折 `SHIPPED`** —— SO 2026-08-22 已经把 Shipped 并进 Delivered，CO 若照旧摆两个页签，反而是新的不对齐 |
| 3 | PCO / PCR 补 On Hold 的按钮 | 两支列表＋内页 | `po_status` / `grn_status` 已经有这个值 |
| 4 | 修 §2.3 那个 hold 会被盖掉的 bug | `purchase-consignment-receives.ts` 的 `recomputePcoReceived` | 一行排除条件，照 PO 那边的做法 |
| 5 | 把「没有按钮的页签」补上按钮，或把页签拿掉 | CR 的 `REFUNDED`、PCR 的 `CLOSED`、PCT 的 `COMPLETED` | 二选一，都是小改 |

> 第 1 和第 3 项**不会有任何单据自己动**。它加的是一个人可以按的暂停键，
> 按了才会有事。

### 第 2 层 — 中等（估：3～5 天，要一支 migration，要照顾已经存在的资料）

| # | 做什么 | 为什么比较贵 |
|---|---|---|
| 6 | 给六张 consignment 单各写一支**转换规则**（什么状态能跳到什么），像 SO 的 `so-lifecycle-guards.ts` | 现在是「送什么写什么」。补规则会让一些**今天做得到的事变成做不到** —— 要先确认没有人靠那个行为在做事 |
| 7 | `do_status` 和 `delivery_return_status` 加 `ON_HOLD` | 一支新 migration（编号要在合并当下重新看，目前树上最大是 `0323`）。**enum 加值是不能反悔的** —— Postgres 不给删标签，所以加进去就永远在 |
| 8 | CN / CR 加 On Hold 的按钮与页签 | 要等第 7 项 |
| 9 | 把 CN / CR / PCT 列表那三份自己抄的状态名字表收回共用的那一份 | 纯整理，但要一张一张比对，不能顺手「统一」掉真的有差别的字 |

> **第 7 项要特别小心一件事：DO 自己现在也没有 On Hold。** 也就是说这不只是
> 「consignment 追上销售链」，而是**销售链跟 consignment 一起往前走一步**。这是不是
> 老板的意思，§5 有问。

### 第 3 层 — 贵（估：2～3 週以上，会碰到库存与钱）

| # | 做什么 | 为什么贵 |
|---|---|---|
| 10 | CO 的 `DELIVERED` 自动推算（CN 覆盖了 CO 的行就跳） | 要新写一支同步、要处理 CN 取消时退回去、要处理部分出货。销售链那支 `so-delivery-sync.ts` 是这个系统最容易出事的地方之一 |
| 11 | CO 的 `READY_TO_SHIP` 自动推算 | 要让备货引擎认识 consignment 表。备货引擎同时管 MRP 和采购建议 —— **改错会影响到真正的销售订单**，不是只影响寄卖 |
| 12 | CN 加一个出货前的「确认」步骤（`LOADED`） | **这等于改变什么时候扣库存**。今天 CN 一开单就扣，加了这一步就变成两段式 |
| 13 | consignment 的 `INVOICED` | 在决定寄卖怎么开发票之前，**这件事没办法开工** → §5 |

**建议的顺序：第 1 层先做完给他看，再谈第 2 层。** 理由是第 1 层做完，他要的那句
「每个 Status 都应该有 On Hold 和 Cancel」在他最常看的那两张单（CO、CN 的 Cancel
本来就有，CO 的 Hold 补上）已经成立，而且完全没有任何单据会自己动 —— 出事的面积
是零。第 3 层在 §5 有答案之前不要开工。

### 大型 ERP 是怎么做这件事的

老板要求过要看外面怎么做，所以讲一下我们跟惯例的差别 **（LIKELY —— 这是通用产品知识，
不是我在这个专案里量出来的）**：

- **SAP / Odoo / NetSuite 的寄卖不是另一套单据，是同一套单据上的一个「所有权旗标」。**
  寄卖库存是「在我仓、别人的」，走同一条销售流程，只是收入认列的时点不同。
- **我们这边是另开了一整套 clone 出来的表。** 好处是 clone 当下不会弄坏销售链；
  代价就是老板现在遇到的这件事 —— **每一个后来加在销售链上的改善，都要再做第二次**，
  而且没有任何东西会提醒你漏了。On Hold 就是最新的一次（`0318`/`0319`/`0320` 三支
  migration 只加在采购链，consignment 那一份没有跟上）。
- **惯例上，「暂停」是文件层的旗标，不是流程状态。** 大型 ERP 多半用一个独立的
  hold flag（可以随时上下、不影响流程排序），而不是把 hold 挤进状态序列。我们两种都
  不是纯的：SO 的 `ON_HOLD` 是一个不排序的状态，效果已经很接近旗标。
  **我的建议（是建议，不是他的决定）：这次照 SO 现有的 `ON_HOLD` 做法做**，不要
  另外发明一个 hold 旗标 —— 一致性最好、最便宜，而且 §2 已经证实资料库有一半已经
  接受这个值了。如果哪天真的要改成旗标，那是整个系统一起改的题目，不该从 consignment
  这边开头。

---

## 5. 只有老板能回答的问题（这里**没有**替他回答）

下面每一条都是业务判断，不是技术问题。技术上每一条都做得到 —— 问题是**该不该**。

1. **寄卖单要不要有「In Production」？** 寄卖的货很多时候**已经在仓库里了**，不需要
   生产。销售订单有这一格，寄卖单要不要跟着有？还是这一格对寄卖根本没有意义？

2. **寄卖怎么开发票？** 现在整条 consignment 链**没有发票单据**。销售订单的
   `INVOICED` 在这里指不到任何东西。是要：(a) 寄卖卖掉之后转成一张正常的销售订单来
   开票？(b) 另外做一套寄卖的对帐/开票？还是 (c) 寄卖就是不开票，这一格永远空着？

3. **Consignment Note 要不要多一个出货前的确认步骤？** 今天 CN 一开出来，货就算出门
   了、库存当下就扣。交货单不是这样 —— 交货单先「装车」再「出门」。要对齐的话就要
   补这一步，代价是**扣库存的时点会改变**，仓库的操作习惯也要跟着改。

4. **「每个 Status 都有 On Hold」是不是也包含交货单自己？** 交货单和退货单**今天都
   没有** On Hold。如果 consignment 那边要有，那对齐的方式有两种：只给
   consignment 加（那 CN 就比 DO 多一个状态，反而更不对齐），或者两边一起加。

5. **Consignment Order 取消之后可不可以复活？** 销售订单是**不可以**的（订金已经变成
   客户的余额了），consignment 现在**可以**（列表有「Reopen SO」）。要对齐的话，是把
   CO 收紧到跟 SO 一样，还是这个宽松是寄卖本来就该有的？

6. **买进来那三张（PCO / PCR / PCT）这次要不要一起做？** 老板点名的是「CO=SO，
   DO=Consignment note」，那是卖出去那条链。买进来那三张要不要一起对齐？

7. **补了转换规则之后，一些今天做得到的事会做不到 —— 可以吗？** 现在这六张单的状态
   API 是「送什么写什么」，补上规则表就会开始拒绝一些跳法。这是想要的收紧，还是会挡
   到现场？

---

## See also

- `docs/modules/document-status-vocabulary.md` — 状态显示的字怎么写，全系统一份
- `docs/modules/sales-order.md` §0 — 销售订单的状态是谁在写、什么时候写，这份提案的
  对照基准
- `docs/modules/delivery-order.md` — 交货单的状态与它的确认步骤
- `docs/modules/delivery-return.md` §7 — 退货单同一类的两个洞（没有合法值清单、
  没有行级锁），那份文件里已经记着 consignment 也有
- `docs/modules/purchase-consignment-order.md` — 目前唯一一份 consignment 的模组说明
  （只涵盖 PC Order）
- `backend/scripts/check-consignment-status-census.mjs` — 这份提案的数字来源

## 日期成对：清空是 `null`，不是空字串（2026-08-31）

寄卖单的表头 PATCH 跟销售单共用同一条「Processing Date 与 Delivery Date 同时有或
同时没有」的规则，也共用同一个坑：编辑页把「清掉的日期」送成 JSON `null`
（`f.processingDate || null`），而判断「这次请求有没有提到这个栏位」原本问的是
「它是不是字串」—— `null` 不是字串，于是一次清空被当成「没提到」，规则拿旧的那一
行去判断新的那一行。

两边现在都走 `effectiveDateAfterPatch`（`scm/lib/date-coerce.ts`），跟真正写进
资料库的那个转换是同一个：`undefined` 才是「没提到」，其余（`null`、空字串）都是
「清掉」。销售单那边两个方向的实测都在 `docs/bugs/0578-*`。

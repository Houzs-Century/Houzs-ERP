# Dashboard 计算方法（Overview 各页）

每个数字从哪里来、怎么算。改了算法就改这里的那一行，不写历史。
代码位置在每节最后一行。

## 0. 所有 dashboard 共用的规则

**时间筛选**
- This month = 本月 1 号到今天。This quarter / This year 同理，都到今天为止。
- 过去的月份 = 那个月 1 号到最后一天。过去的季度、年份同理。也可以自选日期范围。没有半年。
- 如果 This quarter 或 This year 跟 This month 是同一段时间（例如 10 月 1 号到 17 号），就不显示，改成显示 Last quarter。

**两种数字**
- 期间数字：跟着筛选变，例如 "本月开了多少 PO"。
- 快照数字：永远是今天，不跟筛选变，例如 "现在还没到的货"、"现在的库存"。页面上写着 "as of today"。
- 选的是过去的期间时，"还没到 / 逾期" 算到那段期间的最后一天，不算到今天。

**其他**
- 只算当前公司（company_id）。售后服务案例按老板 2026-07-19 的决定跨公司显示。
- 金额一律显示完整的 "RM 15,000.00"，不缩写。
- 点卡片、表格的金额或一行，会在右边打开它背后的明细（送货单、PO 行、案件），可搜索、有合计，点一行打开那张单。

## 1. Procurement Overview（采购）

分两个 tab：Overview 和 Lead time & stock。

### 1.1 Overview tab — 五张卡片

| 卡片 | 算法 |
| --- | --- |
| PO raised this month | 期间内开的 PO（不含 DRAFT、CANCELLED）。金额 = 每行的行总额（已扣折扣），加起来跟 PO 总额一致 |
| Due this month | PO 行上第一次写的交货日期落在期间内的金额。下面一行 "has not arrived yet" = 其中到期末还没收到的部分 |
| Received this month | 期间内收货单（GRN）收到的数量 × PO 单价 |
| Supplier billed this month | 期间内供应商发票（purchase invoice，不含 DRAFT、CANCELLED）的总额 |
| Total outstanding | 所有还没收完的 PO 行，未收数量 × 单价。快照：到今天（或过去期间的最后一天） |

- 没有收货单、但 PO 行被标记成已收的数量（导入时标的），当作在交货日期那天收到：不再算进 Total outstanding 和 "has not arrived yet"，但不算进 Received this month、lead time 和准时率（没有真实收货日期）。
- 表格 "By category / By supplier" 的每一栏，跟上面同名的卡片是同一个算法，只是拆开。

**Outstanding: how late** — 未收的货按 "今天 − PO 上第一次写的日期" 分四段：
迟到 5 天以上；迟到 0–4 天、今天或明天到期；2–7 天后到期；8 天以后到期。
迟到只跟第一次写的日期比，供应商后来改的日期不算（老板 2026-10-17 决定 A）。

**Overdue / Arriving in the next 3 days 清单**（放在最下面）
- Overdue = 未收、且已过 PO 上第一次写的日期。
- Customer date = 这一行挂的销售单的交货日期（有改期用改期后的）。
- 显示 "stock" = 这张 PO 是备库存开的，没有挂销售单。

**What to act on** — 从页面上的数字自动写的提醒：未到货的比例、逾期行数、可以晚订几天的类别、准时率低于 60% 的供应商、dead stock 金额。

### 1.2 Lead time & stock tab — Lead time 表

只看期间内收到的货（选 This month 就是本月的收货）。

| 栏目 | 算法 |
| --- | --- |
| Receipts | 期间内的收货行数（不含上面说的 "导入时标为已收"） |
| Supplier takes · average | 每一条收货：收货日期 − PO 日期，取平均。下面小字是中位数（正中间那一行），几条特别慢的单拉高平均时可以对照 |
| On time | 在 PO 上写的交货日期（第一次写的）当天或之前到货的行数 ÷ 收货行数 |
| Late by · average | 迟到的行，迟到天数加起来 ÷ 迟到的行数。意思：供应商一迟到，平均迟几天 |
| Lines with a customer date | 这些收货里，有几行挂了销售单。少于 10 行时后面两栏照样显示，但变灰并注明只有几行 |
| Date on PO before customer date · average | 客户交货日期 − PO 上写的交货日期，取平均（小字是中位数）。意思：我们平均叫供应商比客户日期早几天到货；数字大 = 采购常常叫货太早 |
| Arrives before customer date · median | 客户交货日期 − 实际收货日期。正数 = 提早到 |
| Could order later by | 把 "提早到的天数" 排好，取第 20 百分位（最晚那 1/5 的货还提早几天）。晚这么多天下单，仍有 8 成的货赶得上客户日期 |
| MRP setting | 现在 MRP 用的天数（全公司）。下面的小字是个别仓库的设定（东马含船期） |
| Suggested | 8 成的收货在几天内到。用它当 MRP 天数，大部分订单仍赶得上 |
| Apply | 按了才改 MRP 里这个类别的全公司天数（MRP 叫你比客户日期早几天下单），个别仓库的设定不动（老板决定 C） |

- 少于 10 行的数字不可靠，显示 "too few lines"，这一行变灰。
- 备库存的 PO（没挂销售单）没有客户日期，不算进跟客户日期有关的两栏，所以不会把天数拉长。
- 后台另有估算（页面不显示）：备库存的货按先进先出配给后来送出的订单，算出这些 PO 比客户下单早或晚几天开（`/api/scm/procurement-overview/stock-ordering`）。

### 1.3 Dead stock 和 Buffer stock（快照，今天）

- 范围：现在仓库里有货的每个品项。不含 SHOWROOM、DISPLAY 仓库，因为展示品会当样品卖掉。
- 订单按 **品项 + 款式** 对货：沙发、床架要面料、尺寸都一样才算同一款。
- **Dead stock** = 完全没有未完成的订单要这个款式，扣掉平时 14 天会卖出去的量后剩下的（不再要求 90 天没出货）。图表按 "多久没出货" 分段：90 天内、91–180、181–365、超过一年。
- **Buffer stock（太早买的）** = 库存 − 有交货日期的订单 − 平时 14 天会卖出去的量。没有交货日期的订单要的货，可以等客户定了日期再买，所以也算 buffer。
- 14 天出货量 = 这个款式最近每天平均出库量 × 14（没有记款式的库存用整个品项的出货量）。
- 最后入库日期 = 还在库存里的那批货的入库日（库存批次记录；AutoCount 转入的期初库存也有日期）。放了几天 = 今天 − 最后入库日期。
- 金额 = 数量 × 成本（v_inventory_value）。
- 注意：ERP 的出库记录从 2026-09 才开始。

### 1.4 Stock turnover and sellers

**Turnover（不跟筛选变）**
- 固定看过去 12 个月。ERP 出库记录不满一年时，从第一笔出库开始算。
- 一年周转几次 = 最近一年出库的成本 ÷ 现在的库存金额。不满一年时，按已有天数换算成一年。
- 库存够卖几天 = 现在的库存金额 ÷ 每天平均出库成本。
- 出库没有成本的记录会让周转率偏低，页面上有显示有几笔。

**Top / Low sellers（跟筛选变）**
- 按期间内销售单的数量排（不含 DRAFT、CANCELLED，老板决定 B）。
- 不含服务项目（运费、丢旧货、搬楼等）。
- 沙发按型号合并（品号第一个 "-" 前面那段）。
- 库存够卖几天 = 现有库存 ÷ 期间内每天卖出的数量。少于 14 天显示红色：该补货了。
- Low sellers = 有库存、但期间内卖得最少的，同数量时库存金额大的排前面。

代码：`backend/src/scm/lib/procurement-period.ts`、`backend/src/scm/routes/procurement-overview.ts`、`frontend/src/pages/scm-v2/ProcurementOverview.tsx`

## 2. Logistic Overview（物流）

分三段：1 本期已送；2 还要送（截至今天）；3 报表。可以选仓库，默认是全部仓库。

### 2.1 本期已送

- "已送" = 期间内开出的送货单（DO，状态 LOADED 或 DELIVERED），按 DO 日期算，也就是货上车那天。不等司机拍签收照（POD），否则司机忘了关单，那天就会显得送得少；没关单的另外在 Process gaps 显示。
- Average per order = 送货单金额 ÷ 送货单张数。只算送货单，不含售后服务案例。
- 按类别的平均：一张 DO 有床垫也有床架，就在两个类别各算一次，各自只算那个类别的金额。免费送的（配套床架、赠品枕头）和收费项目（运费、丢旧货、仓储）不算。
- Average per lorry, per day = 当天有记录车牌的 DO 金额 ÷ 当天出车的车数，再按整个期间平均。车牌来自 DO 上的司机组（crew），没有的话用它被排进的那一趟车。现在大部分 DO 没填车牌，所以这一栏多数是空的。
- Lorries：每辆车出车几天、送几张单、营业额、出车那天平均多少。Occupancy = 出车天数 ÷ 期间内到今天为止的工作天数（星期日不算）。自己的车没出车的天数也列出来，因为司机和分期付款是固定成本。
- Each lorry, each day：每辆车每天送了几张单、多少钱。
- By region：按客户所在的州，归到 Delivery Planning 的区域（KL / Selangor、Northern、Southern、East Coast、East Malaysia）。
- Jobs dated in the period, by type：Delivery Planning 上日期落在期间内的工作（送货、安装、拆展、售后上门等），以及其中已完成的数量。

### 2.2 还要送（快照，今天）

- 范围：还没送的销售单（Delivery Planning 上不是 DELIVERED 的）。
- 按交货日期分段：已逾期、3 天内、4–7 天、8–14 天、15–30 天、30 天后、没日期。交货日期有改期用改期后的。
- Not ready (stock) = 还没齐货的单数。Date agreed = 已经跟客户确认改期日期的单数。
- Overdue 清单：交货日期已过还没送的，最旧的排前面，显示原定日期和逾期天数。
- Due in 3 days, not ready：3 天内要送但还没齐货的。
- Delivering today：交货日期是今天、还没送的单。
- Customer follow-up：Delivery Planning 上的跟进状态（等客户回复、要改期等）。

### 2.3 报表

- Weekly：跟着筛选的月份分周：W1 = 1–7 号，W2 = 8–14，W3 = 15–21，W4 = 22–28，W5 = 29 号到月底；选季度或年份时每个月各分五周。DO 张数和金额按 DO 日期；Marked delivered = 状态已签收的。
- Monthly：每个月开出的 DO 张数和金额。ERP 接手 DO 之前的月份会偏低。
- Process gaps：开出超过 7 天还没关单的 DO；已送但 30 天后还欠款的订单；最近 90 天没有成本的 DO；没有电话的未送单。

代码：`backend/src/scm/lib/logistic-period.ts`、`backend/src/scm/routes/logistic-overview.ts`、`frontend/src/pages/scm-v2/Logistic*.tsx`

## 3. Quality Overview（售后服务）

**卡片**
- Opened = 期间内开的案子（不含作废）。Closed = 期间内结案的，不管哪天开的。
- Ongoing now = 今天还没结的所有案子。
- Overdue now = 还没结、而且现在这个阶段已经待满或超过这个阶段的目标天数。跟阶段图上的 breached 是同一个算法。
- Average to close = 最近 30 天结案的案子：结案日 − 开案日，取平均。不跟筛选变，旁边附上再前 30 天的数字对比，看得出速度有没有变快。

**图表**
- Time spent in each stage = 最近 30 天（可切换 90 天）结束的阶段，每个阶段平均待了几天。超过 10 天红色、5 天以上黄色。
- How old the open cases are = 今天还没结的案子，从投诉日到今天几天，分段计数。
- Monthly trend = 最近 12 个月每月开案数、结案数。红线 = 那个月结案的案子平均几天结案。下面的表还有月底还没结的案子数。没有结案日期的旧导入案子当作已结。
- Overdue cases 清单 = 同上 Overdue now。按阶段分 tab：数字 = 这一阶段的未结案子，红色小数字 = 其中已过期的。

**Suppliers**
- 只算期间内开的、有填供应商的案子。
- Service case rate = 这个供应商案子里的件数 ÷ 期间内从他那里收到的件数。例：收了 1,000 件，50 件出问题 = 5%。5% 以上红色。
- 超过 100% 显示 "check code"：表示收货登记在另一个供应商代码下（例如公司改名后换了代码）。
- Average to close、各阶段天数：算法同上，只看这个供应商的案子。
- 选季度或年份时，下面多一张表：每个供应商每个月收了几件、出事几件、比例多少。选单月就只有那个月。
- 没填供应商的案子不算进来，页面上有写有几个。

代码：`backend/src/routes/lib/assr-quality.ts`、`backend/src/routes/assrQuality.ts`、`frontend/src/pages/QualitySummary.tsx`

## 4. Project Overview（项目 / 展会）

- 项目按开始日期归到期间。
- Sales：有在项目里填账（keyed books）就用填的；没填就用这个项目的销售单金额，COGS 用销售单成本。每个项目标明数字来源（Books / Sales Orders · not settled / No sales yet）。
- Gross profit = Sales − COGS。Net profit = Gross profit − 租金 − 佣金 − 搭建 − 运输 − 宣传品 − 其他。
- Trend：先看每一年，点一年看它的四个季度，点一个季度看它的三个月，点一个月看这个月每周（1–7、8–14、15–21、22 号到月底）。点某一周，整页就切到那一周。
- Where each ringgit of sales goes：只显示有金额的成本。
- Events by stage：每个活动卡在项目页进度条的哪一步。迟几天按 checklist 任务自己的 SLA 截止日（活动开始日 + 模板给该任务的天数），取过期最久的那个；过期就是红色。每个步骤 tab 的红色小数字 = 这一步有几个活动已过期。
- Breakdown：按品牌 / 展会类型 / 主办方 / 场地 / 州合计，营业额大的排前面。点一行，下面就只列它的项目。
- 首页的 "项目营业额、净利" 用的是同一套算法。

代码：`backend/src/routes/projectOverview.ts`、`frontend/src/pages/projects/projectOverviewModel.ts`、`frontend/src/pages/projects/ProjectOverviewPage.tsx`

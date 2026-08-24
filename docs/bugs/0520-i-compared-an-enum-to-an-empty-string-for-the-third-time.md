## I compared an enum to an empty string, for the third time [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**白话.** `probe-misbucketed-stock` 第一次对 prod 跑，**四节只量到两节就拒绝报告**。
守门做对了它该做的事 —— 而那个守门是 `0511`、`0512` 换来的。三个错都是我的，其中
一个是**同一类错误的第三次**。

- **发现:** 2026-08-22，第一次 dispatch 之后
- **状态:** 已修

### 一、拿 enum 去比空字串

```sql
COALESCE(p.category, '')     -- ❌
```

`scm.mfg_product_category` 这个 enum 没有 `''` 这个成员，Postgres 直接拒绝那个字面值：

```
invalid input value for enum scm.mfg_product_category: "" [22P02]
```

**第二节（钱）和第三节（沙发没批号）两节都死在这里** —— 也就是老板真正要的那两个
数字。

这个形状的历史：

| 时间 | 发生什么 |
|---|---|
| migration 0155 | 在 `fn_reconcile_dropship_batch` 里修掉一次 |
| `docs/bugs/0511` | 我在 `probe-convert-link-gaps` 重现，四条链全挂、退出码 0 |
| **这一次** | 我在 `probe-misbucketed-stock` 又重现一次 |

修法一样：**先 cast 再 coalesce** —— `COALESCE(p.category::text, '')`。

### 二、表名错

`scm.consignment_order_items` 不存在 `[42P01]`。寄售是按单据类型分表的：
`consignment_sales_order_items`、`consignment_delivery_order_items`、
`purchase_consignment_order_items`。

### 三、料号栏位，我读 migration 读出了退役的拼法

我从 migration 里读出 `purchase_consignment_order_items` 的料号栏叫 `material_code`，
于是把 `LINE_TABLES` 改成每张表自己带栏位名。

`audit:vocabulary` 挡下来了：**`material_code` 是已退役的拼法**，而
`purchase-consignment-orders.ts:132` 在一条活的路由里就是 select `item_code`。
五张表用的是同一个名字，所以那个参数化整个是多余的，跟着拿掉。

### 不量的，要讲出来

另外两张寄售表（sales / delivery）**完全没有**料号、类别、规格栏位，所以这支 probe
问的问题对它们问不出口。

它们现在印在 `NOT_MEASURED` 清单里，一张一行。**一个族群从清单里消失，读的人会当作
「有涵盖而且干净」** —— 那正是第零节普查本来要防的同一个谎。

### 那次坏掉的跑，确实产出的数字

| | 带规格的行 | 钥匙会变 |
|---|---|---|
| 销售单 | 238 | 0 |
| 采购单 | 131 | **2** |
| 收货单 | 105 | **2** |
| 送货单 | 92 | 0 |

那四行全部是同两个料号 —— `2376-1A(RHF)` 和 `2376-1A(LHF)` —— **存下来的类别是空白**。
料号在主档找不到的行：四张表都是 0。

**这些数字还不完整**，钱那一节没跑到。修好之后要重新 dispatch。

那两个料号后来还牵出另一个病：带括号的料号搜寻搜不到（`docs/bugs/0519`）。

### 相关

- `docs/bugs/0511` — 同一个 enum 错误的上一次
- `docs/bugs/0512` — 「量到 0」和「读不到」长得一样，所以要有不带条件的普查
- `docs/bugs/0517` — 这支 probe 为什么存在

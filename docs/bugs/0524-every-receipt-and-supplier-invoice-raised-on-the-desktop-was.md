## Every receipt and supplier invoice raised on the desktop was recorded as having no parent [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板：「为什么这些 sync 不到」、「我全部要可以 sync now 啊 而且是真的可以用
的 不是摆设品」。

**桌面版的转换画面，从来没有呼叫过转换端点。** 你在采购单上按「Transfer to Goods
Received」，挑完行之后落在 New 表单上，而 New 表单打的是**手建收货单**那条路 ——
那条路一律把单据记成「没有母单」。

结果：单据进不了 AutoCount，而且**连 Send now 都不给**，因为「没有母单」这一类刻意
不准重送。

- **发现:** 2026-08-23，老板在 AutoCount Sync 画面上截图
- **状态:** 已修

### 画面上就自相矛盾

```
WHAT WAS SENT   Goods received from a purchase order
判定            There is no earlier document to carry across
```

两句同时印在同一行上。prod 上四张收货单全部是这个样子。

### 旧的理由，为什么不成立

`POST /grns` 的注解写着：就算带了 `purchaseOrderId`，送转换也会是**错的** ——
因为 AcSyncService 会用 AutoCount 自己的未结条件去解来源行，帐本会收到采购单的
未结行，而不是收货的人实际打进去的数量。

**这句话只有在 payload 不带 `DtlKeys` 的时候成立。**

ERP 会指名它到底拿了哪几行：`readConvertSourceKeys` 在 `enqueueConvert` 里面被呼叫，
**指名得出每一行才回传，指不出来就拒绝**。`/from-po-items` 送的就是这个形状。

所以正确的修法不是「不要送」，是「送，而且指名」。

### 修法

两条建立路径改成：**行上指得出母单就送真的转换，指不出来才记「没有母单」。**

| 路径 | 有母单 | 没有母单 |
|---|---|---|
| `POST /grns` | `po_to_gr` 转换 | 记「没有母单」 |
| `POST /purchase-invoices` | `gr_to_pi` 转换 | 记「没有母单」 |

母单是**从行上读的**（`grn_items.purchase_order_item_id`、
`purchase_invoice_items.grn_item_id`），**不是从表头那个 `purchaseOrderId` 提示读的**
—— 因为行上那个正是 `readConvertSourceKeys` 会去指名的东西，这样两边不可能对不起来。

Send now 也跟着回来了：这些行现在是 `pending`，失败会变 `failed`，而 `failed` 是准
重送的。

### 顺序不用另外做

转换的 payload 会带来源单据的 `linked_ac_docno`。母单还没进 AutoCount 的时候，
**整笔转换会等**，不会送出半套。所以「先推 PO、再推 GR、再推 SI」是自动成立的。

### 测试

两个方向都钉住：**有母单要送、没母单要记**。只修一边都是另一个 bug —— 全部都送，
等于把真正手建的收货单也当成转换送出去。

而且 `between()` 找不到锚点时回空字串、**不在载入时丢例外** —— 会丢的话，未修的程式
会报「no tests」，那读起来像档案坏了不像失败。先证明 RED：6 个案例全挂。

用 `?raw` 读原始码，不用 `node:fs` —— 这是 Workers 专案，没有 node 型别，用 fs 会
typecheck 红而测试绿。

### 这是同一个 bug 的第三次

**销售发票那一边 2026-08-17 就修过了。** `scm/lib/si-autocount-source.ts` 的档头写着：
`POST /sales-invoices` 里那个无条件的 `recordParentlessCreate`「宣称了一个它从来没有
查证过的事实，把每一张桌面版从送货单开出来的发票都归成 ERP-only」。

**一模一样的句子，一模一样的修法** —— 只是当时只修了 SI，GRN 和 PI 被留在原地又跑了
六天。这一支是把剩下两个补上。

### 这支**没有**修的

**AutoCount 那台机器现在回 502。** 讯息是
`masters not opened, document not sent: error code: 502`，而「error code: 502」这串
**是 AutoCount 服务自己回的内容**（不是我们的 fallback 文案，也不是连线错误）。
在那台机器恢复之前，送出去还是会失败 —— 这一段不在 ERP 里。

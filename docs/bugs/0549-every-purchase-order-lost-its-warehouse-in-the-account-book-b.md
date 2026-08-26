## Every purchase order lost its warehouse in the account book, because AutoCount skips an over-long value instead of refusing it [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-24,再问一次 2026-08-26:

> 「我的 PO 明明应该是 Bintang Warehouse,但去到 AutoCount 里面它却变成了 HQ」
>
> 「你知道我的 PO 它会自动变成选择 HQ 吗?」

**不是没带过去。带了,被 AutoCount 无声丢掉。**

ERP 的仓库叫 `KL WAREHOUSE`(12 个字)。`dbo.Location.LocationCode` 只有 **8 个字**。
AutoCount 遇到塞不下的值,**不是拒绝这张单,是跳过这个栏位然后照常存档**。主机自己的
log,2026-08-25:

```
set skipped: Cannot set column 'PurchaseLocation'. The value violates the
             MaxLength limit of this column.
set skipped: Cannot set column 'Location'. ...
```

于是采购单进了正式帐本、**没有收货仓**,画面上显示帐本的预设值(HQ),而**没有任何一
个地方说过这件事** —— 队列是绿灯,页面是绿灯,ERP 的 log 也没有。

**为什么只修了一半.** `LOCATION_MAP` 是帐本对每个仓库的**称呼**(`KL WAREHOUSE` 在
那边就叫 `KL`),不是缩写。它一直存在,但只有三个地方在用:

| 送出的地方 | 修这次之前 |
|---|---|
| 销售单 表头 `SalesLocation` | ✅ 有过对照表 |
| 销售单 / 采购单 **每一行** `Location` | ❌ 原样送 |
| **采购单 表头** `PurchaseLocation` | ❌ 原样送 |
| GR / IV / PI 转档表头 | ✅ 2026-08-25 才修的 |

08-25 修转档那次读的是 `warehouse_id`。**采购单没有这一栏** —— 它的仓库是
`purchase_orders.purchase_location_id`,由 `readWarehouseCode` 解,所以整条采购单的路
完全没被那次修正碰到。**「同一个问题修过了」在这里是假的,因为它走的是另一条路。**

**修法.** 两个漏掉的地方接上同一个 `bookSpellingOrOwn(..., LOCATION_MAP)`:

- `autocount-read.ts` `readWarehouseCode` —— 采购单表头
- `autocount-outbox.ts` `withLocations` —— 每一行

**没有新逻辑**,就是把已经在用的那一个呼叫补到漏掉的两处。对照表不认得的仓库**照旧原样
送**,不替任何人发明一个帐本代号。

**钉住的方式.** `convertWarehouseSpelling.test.ts` 现在也涵盖采购单:表头用假的
Supabase client 真的跑一遍(`KL WAREHOUSE → KL`、`PG WAREHOUSE → PG`、没对照的不变、
没仓库还是 null),行的那支是 module-private,所以钉在原始码上 —— 改回原样送就会红。

**教训:AutoCount 的静默跳过是一整类 bug,不是一个 bug。** 主机的 `Set()` 会吞掉例外
再回报成功,所以「送出成功」从来不等于「帐本改了」。凡是我们送进去的栏位,都要问一句
「它塞得下吗」。

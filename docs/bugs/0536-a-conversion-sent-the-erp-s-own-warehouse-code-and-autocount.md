## A conversion sent the ERP's own warehouse code, and AutoCount silently dropped it [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 收货单进了 AutoCount,**但仓库栏是空的** —— 而且没有任何地方讲过这件事。
不是 outbox、不是同步页、不是 ERP 的 log。

主机自己的 log 里写着(2026-08-25,那张带 `KL WAREHOUSE` 的 PO → GR):

```
set skipped: Cannot set column 'Location'.
             The value violates the MaxLength limit of this column.
set skipped: Cannot set column 'PurchaseLocation'. ...
```

**AutoCount 不拒绝这张单,它跳过那一栏然后照样存档。** 所以帐本里有一张没有仓库的
收货单,而 ERP 这边一切看起来正常。

**原因:同一个问题有两个答案。**

| 路径 | 送出去的值 |
|---|---|
| 开单(create) | `bookSpellingOrOwn(..., LOCATION_MAP)` → `KL` |
| **转档(convert)** | **`warehouses.code` 原封不动** → `KL WAREHOUSE` |

`LOCATION_MAP` 里每一个帐本代码都 **8 码以内**(`KELANA.J`、`C&C DISP`)。
`KL WAREHOUSE` 是 **12 码**。

**这不是截短,是翻译。** `KL WAREHOUSE` 变成 `KL`,是因为帐本里那个仓库**就叫 KL**,
不是因为 KL 比较短。对照表不认得的仓库照旧送自己的码 —— 行为不变,不会替没有人对应过
的仓库凭空发明一个帐本位置。

**老板 2026-08-25 讲的正是这件事**(讲的是 supplier code):内部码要经过 binding 换成
对方的码,而且**只能有一份对照**。这一条是同一个毛病的另一个位置。

```enumeration
backend/src/scm/lib/autocount-convert-lines.ts — 转档也过 LOCATION_MAP
backend/src/scm/lib/convertWarehouseSpelling.test.ts — 对照表每个值都要塞得下
```

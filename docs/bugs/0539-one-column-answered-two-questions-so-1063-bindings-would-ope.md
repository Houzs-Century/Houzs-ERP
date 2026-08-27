## One column answered two questions, so 1,063 bindings would open an item the account book never had [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-25:「我做 SKU Binding 来干嘛呢?」、「这整个东西完全跟我们系统的
功能不一样」。

`scm.supplier_material_bindings.supplier_sku` **一栏,两个读者**,而且各自都以为那栏是
自己的:

| 谁在读 | 它以为那是 |
|---|---|
| 采购单 / 收货单 / 采购发票 PDF | **供应商**照着做的码 |
| AutoCount 写回 | 写进**正版帐本**的 ItemCode |

第二个读者是 **#2031(2026-08-11)** 接上去的 —— 接到一栏**已经属于采购**的栏位上。

**普查量出了代价。** `scripts/ac-item-code-census.mjs` 对全部 **3,076 笔** binding 用
真正的解析器跑过:

```
IN BOOK     1874
WOULD OPEN  1063   ← 帐本没有这个码，会被开成新品项
REFUSED      139   ← 全部是 ambiguous: … none belongs to supplier
```

**而会动的那些,规则非常干净:** 值如果**本身就是帐本的 ItemCode**,它直接胜出
(`index.acCodes.has(bound)`)—— 不比对供应商、不会有歧义、不开新品项。
Hookka 那 50 笔会动的床架填的是 `HOK-1019 (SK)`;139 笔被拒的填的是 `1007-(K)`
这种帐本从来没听过的。

**ItemCode 在 AutoCount 就是库存身份。** 进货记在一个码、出货记在另一个码,
两边永远对不平 —— 所以这是一个栏位的问题,不是一个惯例的问题。

**这一笔只加栏位,不改任何单据。** 可空、无预设、无约束、不动 view、不 backfill。
NULL 就是「没有答案」,也就是今天的行为(解析器本来就会退回切换快照)。
**填值是另一步,有自己的预演;读它的程式是第三步。** 一支会悄悄改变「什么东西进正版
帐本」的 migration,正是这里最不该有的东西。

```enumeration
backend/src/db/migrations-pg/0326_supplier_binding_ac_item_code.sql — 只加栏位
backend/src/scm/lib/autocount-outbox.ts — ac_item_code 优先，supplier_sku 保留为退路
backend/src/scm/lib/acItemCodeColumn.test.ts — 钉住顺序与 migration 的克制
```

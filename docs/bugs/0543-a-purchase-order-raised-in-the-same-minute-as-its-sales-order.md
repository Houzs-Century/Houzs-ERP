## A purchase order raised in the same minute as its sales order lost its link in the account book [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-26:

> 「明明我的 PO 是通过 Transfer from Sales Order 来开的,可是进到 AutoCount 那边,
>  它们之间却确实没有建立 Transaction Relationship」

**因为那张 PO 是用「凭空开」送进去的,不是转档。**

```
create_po  SENT 1 ... last 2026-08-25T16:55   ← HC-PO-2608-007
so_to_po   SENT 5 ...                          ← 之前五张都正常转档
```

**为什么会变成凭空开。** 决定「要不要转档」看的是销售单行有没有 AutoCount 行号
(`mfg_sales_order_items.linked_ac_dtlkey`)—— 而**那是销售单送进帐本之后才回填的**。

```
开 SO  →  马上转 PO  →  SO 还没进帐本  →  行号是 NULL
       →  判定「帐本没有这些行的 key，转档定位不到」
       →  改成凭空开  →  帐本里两张单永远没有关联
```

**那句判定在那一瞬间是真的,五分钟后就是假的,而且从来没有人重新问过。**
前面五张会正常,只是因为开得够晚。**这是抢时间,不是规则。**

**而凭空开是唯一收不回来的答案** —— 转档少了可以补,凭空开进帐本之后,那张单跟销售单
就再也接不起来了。

**修法:第三种形状 `wait`。** 没有行号、而且来源销售单**还没进帐本** → 不判定,排进
队伍等,`fromDoc` 指着那张销售单,排水本来就会 hold 到它有号码为止。行号在**排水时**
补上(`dispatchOne` 里已经有三个同形状的补写:CreditorCode、DocNo、DebtorCode)。

**没有行号、但销售单已经在帐本里** → 那才是真的缺,凭空开是诚实的答案。
**为库存备料、或跨两张销售单** → 也是凭空开,没有单一的锚可以等。

**补写要嘛全部要嘛不补**:补一半会送出一张「看起来完整、其实少了几行」的采购单,比服务
直接拒绝一个空阵列更糟。

```enumeration
backend/src/scm/shared/po-transfer-shape.ts — wait 形状
backend/src/scm/lib/autocount-read.ts — sourceSoInBook
backend/src/scm/lib/autocount-outbox.ts — wait 当转档排队 + 排水补行号
backend/src/scm/shared/po-transfer-shape.test.ts — 五个案例，含「已在帐本仍无 key → create」
```

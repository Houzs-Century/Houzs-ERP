## A transfer sends no ItemCode, and was being refused over one [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-25:

> 「如果它是 by convert 的,那肯定是先跟 Sales Order 的 SKU 进行 convert……
>  SKU 可能就不用看了。除非是凭空 create 出来的……才会根据 SKU 去找」

**他是对的,而且机制上完全吻合:**

```
AddSOToPOTransferDetail(Int64)   ← 只吃来源行号，AutoCount 自己复制料号
composeSoToPo → DtlKey · UnitPrice · Qty · Location · DeliveryDate
                ↑ 没有 ItemCode
```

**转档不送料号。** 采购单在帐本里的料号,是 AutoCount 从销售单那一行**抄**过去的。

**但程式做的是相反的事。** 转档那条路会**先组一张完整的 create payload** ——
那一步会解析每一行的料号、解析不出来就丢 `ItemCodeError` 整张拒绝 —— 然后
`composeSoToPo` **把解析结果全部丢掉**。

**所以一张根本不需要料号的采购单,因为料号被拒了。**

2026-08-25 量过:**139 笔** binding 解析成
`ambiguous: … none belongs to supplier`(例如 `CODY-(K)` 对到
`HOK-1007 (K)@400-O002` 和 `NB-KHJ57(K)@400-N002`,而 binding 挂在 400-H003)。
**在转档那条路上,这 139 笔挡的全部是不会被送出去的值。**

**修法**:`ComposeOptions.forTransfer`。转档时,解析不出来的料号**不再拒绝**,那一行
保留下来继续带它真正会送的四个栏位。**create 那条路一个字都没改** —— 那里料号真的
会被送出去、真的会在正版帐本开出品项,拒绝是对的。

**顺序也是修的一部分**:`readPoEnqueueShape` 现在读在 `composeDetails` **之前**。
「要不要料号」是 shape 决定的,所以必须在组行之前就知道。

**那一行为什么保留而不是丢掉**:丢掉会让 `Details` 阵列悄悄变短,`DtlKeys` 对不齐 ——
结果是一张活的采购单上出现错的数量,比拒绝更糟。

```enumeration
backend/src/services/autocount-writeback.ts — forTransfer，转档不因料号拒绝
backend/src/scm/lib/autocount-outbox.ts — 先读 shape 再组行
backend/src/services/transferNeedsNoItemCode.test.ts — create 仍拒绝、transfer 通过、送出去的 bytes 没有 ItemCode
```

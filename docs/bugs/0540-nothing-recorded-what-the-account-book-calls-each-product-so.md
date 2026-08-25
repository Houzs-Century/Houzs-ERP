## Nothing recorded what the account book calls each product, so every document recomputed the guess [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 拆栏(migration 0326)之后,`ac_item_code` 是空的。空的意思是「没有答案」,
系统会退回去用切换上线的快照现算 —— **每一张单都重算一次同一个猜测**。

普查量过全部 3,076 笔:**1,063 笔会在正版帐本开出新品项、139 笔当场被拒**。

**这支工具把答案写下来,而且讲明白是哪一条规则决定的:**

| 规则 | 意思 | 为什么安全 |
|---|---|---|
| **R1** | `supplier_sku` 本身就是帐本的码 | 就是今天正常落地的那 1,874 笔。抄过去**不改变任何现有行为**,但采购从此可以自由改 `supplier_sku` 而不动帐本 |
| **R2** | 快照里这个 ERP 码只对到一个品项 | 没有歧义,解析器本来就这样答 |
| **R3** | 对到好几个,但**只有一个**记在这家供应商名下 | 就是解析器本来在做的那个消歧,只是写下来而不是每张单重算 |

**其余一律留 NULL 并列出来给人看。** 2026-08-25 量到的 139 笔拒绝全部是
`ambiguous: … none belongs to supplier` —— 例如 `CODY-(K)` 对到
`HOK-1007 (K)`(供应商 400-O002)和 `NB-KHJ57(K)`(400-N002),而 binding 挂在
400-H003 底下。**要选哪一个是「谁做这个货」的商业事实,不是脚本可以从前缀推出来的。**
在这里猜,等于把一个错的库存身份写进正版帐本 —— 而那正是这整个栏位存在的理由。

**写入只碰一栏、只碰目前是 NULL 的列**(`WHERE ac_item_code IS NULL`),所以人手填过的
值永远不会被这支覆盖;一列一句在交易里;跑完换一条新连线重读验证每一列都真的落地。

```enumeration
backend/scripts/seed-ac-item-code.mjs — 三条具名规则，算不出来的不猜
.github/workflows/seed-ac-item-code.yml — 手动触发，预设 plan
```

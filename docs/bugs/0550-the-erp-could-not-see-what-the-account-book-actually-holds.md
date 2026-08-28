## The ERP could not see what the account book actually holds, so «sent» has never meant «landed» [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-26:

> 「我 edit 了之后,怎么没输入回去给 AutoCount 呢?」

**目前的系统答不出这个问题。** 队列上那两笔 edit 写着 **sent**,但 sent 的意思只是
「主机回了 200」,不是「帐本改了」。

主机套栏位是这样写的:

```csharp
if (it.ContainsKey("Location")) Set(() => d.Location = Str(it, "Location"));
```

`Set()` **会把例外吞掉**,跳过这个栏位,然后照常回报成功。#0549 就是这样过了八天 ——
每一张采购单进帐本都没有仓库,而队列、页面、ERP log 三个地方全是绿灯。

**所以「送出成功」这四个字,从来不代表帐本真的改了。** 而我们没有任何办法去看帐本。

**三个一直答不出来的问题,全都是同一类:**

| 问题 | 谁问的 |
|---|---|
| 我 edit 了,到底进去没有? | 老板 2026-08-26 |
| PO 跟 SO 的 Transaction Relationship 真的建立了吗? | 老板 2026-08-24 |
| 这一行带的是哪个仓库? | #0549 |

**三个都是在问「帐本里面长什么样」,而不管怎么翻我们自己送出去的 payload 都答不出来。**

**东西一直都在.** `AcSyncService` 从 2026-08-15 就提供 `/doc-read` —— 两个 SELECT,不开
SDK session,把表头和每一行整个读回来,包含 `FromDocType` / `FromDocNo` /
`FullTransferFromDocList` / `FromSODtlKey`(转档关联)和 `Location`(仓库)。

**这个 ERP 从来没有呼叫过它。** 跟 `/last-errors` 一模一样的情况 —— 答案一直躺在那里,
只是没有人去拿。

**修法:`GET /api/scm/autocount-outbox/book-doc?docType=SO&docNo=...`**

- **双向唯读**:主机端两个 SELECT、不开 session;这边不进队列、不算次数、不重试。
- **跟「重新送」同一把锁**(`REQUEUE_KEYS`)。它会吐出正式帐本里的客户代号、价格和地址,
  不该比会写入帐本的那颗按钮还好拿。
- **`missingColumns` 原样带出来,不丢掉。** 主机会回报「你要的这一栏,帐本没有」——
  而「AutoCount 根本没有这个栏位」本身就是好几个问题的答案。
- **文件型别在这边也挡一次。** 主机拿这个值去拼表名,它自己有挡;但一个照单全收的路由
  会让主机的挡变成唯一一道,呼叫的人就只能从 500 里面猜规则。

**测试**把 `BOOK_DOC_TYPES` 钉在**主机自己的原始码**上(`?raw` 读 `AcSyncService.cs`,
比对 `static readonly string[] DocTypes`),所以主机改了名单,这边会红,而不是等到某一天
有人拿一个帐本读得到的单据型别却收到 400。

**下一步(还没做).** 有了这条路之后,才能回答「edit 到底进去没有」—— 把帐本读回来跟
ERP 比对。**这次只加眼睛,不加判断。**

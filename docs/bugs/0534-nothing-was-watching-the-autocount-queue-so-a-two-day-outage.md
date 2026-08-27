## Nothing was watching the AutoCount queue, so a two-day outage was found by noticing the account book was short [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 8/21 晚上主机的服务停掉。**13 张单堆了两天**,老板是靠「发现帐本里少了东西」
才知道的。

**那次停摆的代价,几乎全部来自「多久才发现」。** 通道断了 30 分钟,单据就不再重试了;
之后每多一天,就多一批要人手补送的单。

**已经有一支检查工具了 —— 但它是手动的。** 而且这支工作流程自己写过一句话拒绝排程:

> *a production DB read on a schedule turns a real question into CI noise nobody reads …
> when the sync is live and this needs to become an ALARM rather than a report, that is a
> different mechanism (somewhere a human actually looks), not a cron on this workflow.*

**它的两个前提都变了** —— write-back 8/13 已经上线,而且停摆真的发生了。

**噪音那点是回答,不是推翻。** `ALARM=1` 让它**没事的时候安静通过**:那一天不寄信,没有
人要读任何东西。它只用「失败」讲话,而 GitHub 的失败通知信引用的那一行,直接写**哪一张
单卡住、要做什么** —— 那封信本身就是原文要的「a human actually looks」。

**只有两个条件会响:** 一、outstanding failed(单在 ERP、不在帐本、没有重试次数了);
二、pending 超过 60 分钟(排水是 5 分钟一轮,**12 倍**还没动才算卡住)。

**skipped 故意不响** —— 它讲的是单据的形状,不会自己改变。为了一张手键入的收货单每天
响一次,正好是原文拒绝的那种噪音。

**做的时候抓到它会误报。** 清空之后 `HC-DO-2608-003` 那笔失败纪录还在,但它的送货单已经
被删了 —— 报告那句「each is a document that is in the ERP」对它已经是假的。看门狗会为一张
不存在的单每天响一次。所以现在会先查单据还在不在:不在的照印,但**不算数、不响**。

```enumeration
.github/workflows/autocount-outbox-health.yml — 每天 01:00 UTC，ALARM 只在排程时开
backend/scripts/check-autocount-outbox-health.mjs — ALARM 判定 + 单据存在检查
```

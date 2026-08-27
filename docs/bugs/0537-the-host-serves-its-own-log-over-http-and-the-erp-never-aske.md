## The host serves its own log over HTTP and the ERP never asked [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 一张转档单失败时,ERP 只记得十一个字:`Invalid transfer item.` —— 那句话
**什么都没讲**:没讲哪一行、没讲哪张单、没讲原因。

真正settle 这件事的那一行,是服务自己写的:

```
target debtor before transfer = [...] (from the payload)
```

它写在办公室那台机器的 `C:\Temp\ac-sync-service.log` 里。要读它得开 TeamViewer、开
Notepad、在一个 377 KB 的档案里拖捲轴 —— 2026-08-25 我这样做了一个小时,**还是没读到**。

**而那支服务一直都愿意用 HTTP 把那一行给出来。** 它有 `/last-errors` 这条唯读路由。
2026-08-25 grep 全 repo:唯一提到 `/last-errors` 的档案,就是那支提供它的 C#。
四条唯读路由(`/last-errors`、`/doc-read`、`/further-description`、`/picture-census`)
从 ERP 的角度**全部是死码**。

**为什么另开一支呼叫器,而不是加一个 `AcOp`。** 每一个 `AcOp` 都是「一列 outbox 可以
是的东西」—— 有状态、有次数、有重试策略的**单据操作**。读 log 三样都不是。塞进那个
词汇表,等于让一个不是单据的东西混进一个「每个成员都是一趟单据旅程」的集合,而队伍里
每一个 `switch (op)` 从此都要写「除了这一个」。

**一栏两用正是老板 2026-08-25 亲口指出的毛病**(`supplier_sku` 同时是供应商料号和
AutoCount 料号)。这里是同一个形状,现在拒绝比以后拆开便宜。

```enumeration
backend/src/services/autocount-host-read.ts — callAcRead，与 AcOp 不相交
backend/src/scm/routes/autocount-outbox.ts — GET /host-log，权限同 Send again
backend/src/services/autocountHostRead.test.ts — 两个词汇表不得重叠
```

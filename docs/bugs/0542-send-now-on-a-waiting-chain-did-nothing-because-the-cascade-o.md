## Send now on a waiting chain did nothing, because the cascade only knew how to re-queue [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-26:

> 「如果顺着点完,也就是顺着把 SO 点了,再点 DO,然后再点 SI,这样顺着流程走就没问题。
>  但如果我想走捷径,直接去点 Sales Invoice……就不行」

**级联永远先走 `requeueOutboxRow`,而它拒绝 `pending` 的列** —— 回 `row-pending`,
而且那个拒绝本身是对的(排水本来就会去拿它)。

所以当整条链都在 WAITING(= pending,各自等上面那张)的时候:

```
按 SI  →  找到三个上游都是 pending
       →  三次都被回 row-pending
       →  一个都没送，按钮看起来完全没反应
```

**顺着点会动,是因为那等于对每一列直接送** —— 而那正是级联漏掉的事。

**修法**:上游如果已经是 `pending`,就**直接送它**(`sendOutboxRowNow`),不要试图重排。
失败/跳过的才走重排那条路。

```enumeration
backend/src/scm/lib/autocount-cascade.ts — newestOutboxRowWithStatus，回传状态
backend/src/scm/routes/autocount-outbox.ts — pending 的上游直接送
```

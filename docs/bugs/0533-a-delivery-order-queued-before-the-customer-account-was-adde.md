## A delivery order queued before the customer account was added went out without one, and AutoCount called it an invalid item [high]

<!-- area: AutoCount sync + write-back -->

**白话.** `HC-DO-2608-003` 一直失败，AutoCount 只回一句 **"Invalid transfer item."** ——
看起来像是**某一行货有问题**。不是。是**整张单没有客户账号**。

后面还有**五张销售发票**在等它 —— 它们等的是一张永远不会进帐本的母单。

**AutoCount 的错误讯息在骗人。** `AddPartialTransferDetail` 碰到「目标单没有
DebtorCode」的时候，报出来的是「invalid transfer item」，不是「missing account」。
`AcSyncService.cs:988` 那段注解就是在讲这件事。

**为什么会没有客户账号。** 组单的地方从 #2340 开始就有带 `DebtorCode` 了。但是
**排水是把当初存起来的那包东西原封不动送出去，不会重组** —— 所以 #2340 之前排进队伍
的单，到今天送出去还是光的。那张 DO 就是这种。

采购那边的 `CreditorCode` 早就有排水时补写了（#2345、D15），**销售这边一直没有**。
补上，三个补写现在成对。

**这是三个里面最便宜、而且唯一不会失败的一个**：采购那两个要去读一张单才知道账号，
客户账号在这里是个固定常数（`AC_DEBTOR_CODE` —— 一个账户，客户的真名写在上面），所以
没有东西要读，也没有 best-effort 可以掉下去。

`!body.DebtorCode` 那道守卫的意思是：**#2340 之后组的单一个 byte 都不会被动到**。补写
是修旧单，不是覆盖。

```enumeration
backend/src/scm/lib/autocount-outbox.ts — dispatchOne 补写 DebtorCode
```

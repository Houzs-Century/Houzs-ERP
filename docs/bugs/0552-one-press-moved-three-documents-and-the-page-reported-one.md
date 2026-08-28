## One press moved three documents into a licensed account book, and the page reported one [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 按一次 Send Now,可能会有**三张单**被写进正式帐本 —— 发票、还有它上面的销售单
和送货单。**画面只讲了一张。**

后端从补上游那个功能写出来的第一天就在回 `ancestors_sent`。**前端一个字都没读**:

```
$ grep -rn "ancestors_sent" frontend/src
(没有结果)
```

**为什么这不是小事.** 每一张被补上去的单,都是**替操作的人**写进一本有牌照的帐本。他按
的是发票,系统顺手把销售单也送进去了 —— 而他没有任何办法知道这件事发生过。

**最危险的形状:按的那张成功了,上游那张失败了。** 画面只报按的那张 → 读起来就是「都好
了」,但帐本里少了一张,而且没有人知道。

**修法.** `ancestors_sent` 跟着 note 落在**被按的那一列上**,标题 `Sent first`,一张单
一行:

```
SO-A — AutoCount had an older version, sent.
DO-B — AutoCount did not have it yet, sent.
SO-C — AutoCount did not have it yet, not sent — still-refused.
```

**「为什么要先送」跟「送成功没有」是两件事,不能压成一件.** `missing`(帐本根本没有)
和 `stale`(帐本有,但是旧版本)对操作的人是完全不同的两句话,而单号本身讲不出这个差别。

**句子只写一次(`acAncestorLine`),两个画面共用.** 电脑版和手机版各写一次的话,两边迟早
会讲得不一样 —— 这跟 `AC_SEND_NOW_LABEL`、`useAcRequeue` 已经在用的理由是同一个。

**没送成功的也要显示,不是只显示成功的。** 上面那个「最危险的形状」就是靠这条挡住。

**呼叫根本没通的时候,不编造名单。** 那种情况下「送了什么」是未知的,列一份名单等于发明
事实 —— 这跟同一支 hook 里 throw 那一支不引用 `message` 是同一条规矩。

**没有上游要补的时候,一个字都不显示。** 每次按都挂一个空标题就是杂讯,而杂讯正是有用的
那次不再被人读的原因。

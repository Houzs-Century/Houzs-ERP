## The health script did not parse, and nothing was checking that it did [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 我自己在 2026-08-24 改这支脚本的时候,**吃掉了一个字元**:
`const notice = (msg) =>` 变成 `(msg) =`。推上 main 了。

第一个发现的是工作流程自己 —— 跑起来 `ReferenceError: msg is not defined`。而当时
老板正在等这份报告,去查一整条卡住的单链。

**更糟的是我前一天才让这支脚本每天自动跑。** 一支不能 parse 的脚本会**每天失败**,
等于看门狗第一天就在喊狼来了 —— 正好是那支工作流程 header 当初拒绝排程的理由。

**为什么没被挡下来.** 这些脚本是 `workflow_dispatch` 跑的,**没有任何测试 import
它们**。所以语法坏掉,CI 全绿。

`node --check` 是最便宜的守卫,而且刚好涵盖漏掉的这一类。它不宣称脚本是对的 ——
只宣称它是一支程式,那是排程工作的退出码要有意义的**最低门槛**。459 支脚本 8 秒跑完。

```enumeration
backend/scripts/check-autocount-outbox-health.mjs — 还原箭头
backend/tests/opsScriptsParse.test.ts — 每支 scripts/*.mjs 都 node --check
```

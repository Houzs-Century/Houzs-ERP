## Send now only queued, and a child waited for a parent nothing would re-send [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-23 讲的三条：

1. 每一张单都要有 Send now
2. **按下去就是立刻送，不是排队**
3. **按下去要把缺的上游依序补上再送自己** —— 按 SI 就 SO → DO → SI

前两条现在成立了，第三条也是。

- **发现:** 2026-08-23
- **状态:** 已修

### 第二条：按钮只是排队

`requeueOutboxRow` 会写一张新的 `pending`，然后就停了 —— 真正送出去的是那个**五分钟
的扫描**。程式里自己讲得很清楚（`autocount-requeue.ts:193`）：

> THIS row is `pending`: **the drain is already going to send it**

所以按下去 = 进 Waiting 等五分钟。

**两块拼图本来都在，中间没接起来**：`sendOutboxRowNow` 早就会同步送出去，但它**只吃
已经是 `pending` 的行**，而一张 `failed` 的行永远不是。接起来就好。

### 第三条：等母单，不会去推母单

prod 上最老的那一张等待中的：

```
HC-SI-2608-002   do_to_iv   attempts 0
reason: "waiting: parent has no AutoCount document yet"
```

而它的母单：

```
HC-DO-2608-003   so_to_do   failed   attempts 6/6
```

**母单已经用完重试次数，不会再自动送。所以那张发票会等到天荒地老。**

「等」对背景扫描是对的，对**按按钮的人**是错的 —— 他看得到的东西不会有任何变化。

### 修法

`ancestorsMissingFromBook` 往上走链路，**最外层排最前面**，停在第一个已经进帐本的祖先
（它进得去，代表它上面的也进去了）。

停止条件是 **`linked_ac_docno`**，不是 outbox 有没有那一行 —— outbox 记的是「我们试
过什么」，`linked_ac_docno` 记的是「帐本收到了什么」，只有后者能回答「小孩现在能不能
走」。这两个问题本来就一直被混在一起。

**合并转换（一张单来自多张母单）回传空的**，不回传第一张 —— 送一张、剩下的默默不送，
比什么都不送更糟：使用者会看到成功，而帐本还是建不出那张单。

### 两颗按钮现在行为一样

`check:duplicated-decisions` 抓到我：两支端点的回应长得几乎一样，只差两个栏位。

**正确的解法不是加白名单，是让两颗按钮做同一件事。** 串联那一段抽成一支共用的
`sendAncestorsFirst`，两边都用它，回应也长一样 —— 这样它们不可能再对这件事产生分歧。

### 链路的定义没有抄第二份

`UP` 只记每一层三件 `DOWNSTREAM` **没有**记的事（来源行上哪一栏指向母单表头、母单表
叫什么、母单单号栏叫什么）。四条链本身还是读 `DOWNSTREAM`。

第一版是整张抄的，闸门当场抓到 —— 抄一份就是同一条规则有两个家。

### 这支**不能**让单据进得去

**AutoCount 那台机器从 22/08 20:35（马来西亚时间）起一直回 502。**

```
masters not opened, document not sent: error code: 502
```

帐本里现在只有两张单，都是 **21/08** 进去的，在坏掉之前。

**这支修的是「按下去会不会真的送、会不会先补上游」，不是「送出去会不会被收」。**
机器好之前，按下去仍然会失败 —— 差别是**立刻**告诉你失败，而且失败的理由是 AutoCount
自己的话。

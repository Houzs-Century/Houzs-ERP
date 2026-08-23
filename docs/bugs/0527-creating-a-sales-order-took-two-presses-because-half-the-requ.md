## Creating a sales order took two presses, because half the required fields waited behind a return [medium]

<!-- area: Sales orders + pricing -->

**白话.** 老板：「create salesorder 要两次？」

按第一次 → 「还缺 Venue、Delivery State」。补好，按第二次 → 「还缺 address line 1、
postcode」。**第二批本来就该跟第一批一起讲。**

- **发现:** 2026-08-23
- **状态:** 已修

### 这是同一件事的第二半

**2026-08-20 老板就报过一次：「为什么要慢慢爆呢」。** 当时把「一定要填」的那批改成一次
讲完，而地址那一组**留在下面第二个 `if` 里没动**。

留下来的理由写在注解里：那些是「有条件才要检查」的，要等前面的选择做完才知道适不适用。

**这个理由对其他几个成立，对地址那一组不成立。**

### 为什么不成立

地址那一组的条件只有一个：**有没有填 Processing Date。**

而那是**按下按钮的那一刻就知道**的事 —— 不需要等任何选择。它之所以「看起来像」要排队
检查，只是因为它坐在第二个 `if` 里，而第一个 `if` 先 `return` 了。

```
第一个 if：Venue / State 没填 → 讲 → return
                                      ↑ 从来走不到下面那个
第二个 if：processingDate 有填 → 检查地址
```

### 修法

地址那一组抽成 `soProceedingAddressErrors`，跟原本那批**在同一次收集、同一个对话框**讲完。

每一个参数都是**必填的、不是可选的** —— 每一个都决定某个字会不会出现，可选参数会让呼叫
端安静地保留旧行为（CLAUDE.md 的 optional-param-noop）。

### 讯息保留「为什么」

地址那几栏是**因为填了 Processing Date 才变成必填的**。所以：

- 两批都缺 → 一起列，并说明地址那几栏为什么必填
- 只缺地址那批 → **标题就是理由**
- **只缺一个地址栏位时，也不用那句简短的「postcode is required.」**

最后一条是两个测试打架打出来的，而**该改的是程式不是测试**：「postcode is required」
没有告诉操作的人「postcode 是在你填了 Processing Date 之后才变成必填的」，而他没有别
的方法能知道这件事。

### 测试

11 个案例：合并、理由保留、单独一个的情况，加上收集本身（不 proceeding 就什么都不要、
全填好就空的、缺三个要一次全列、「Fill in address later」打勾就算地址缺、只有空白的
Processing Date 不算 proceeding）。

**既有的两个案例签名变了会编译失败** —— 那是刻意的，签名改了就该逼出每一个呼叫点。

前端 typecheck 干净，`so-form-validate` 37/37 过。

（前端全套有 18 个红的在 `delivery-order-template` 和 `dependencySecurity` —— 那些在
main 上本来就红，跟这支无关，也没有动它们。）

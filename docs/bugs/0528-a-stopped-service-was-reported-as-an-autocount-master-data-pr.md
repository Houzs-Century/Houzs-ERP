## A stopped service was reported as an AutoCount master-data problem [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板问了三次「所以是什么问题进不去」，因为画面每次都回答**错的东西**。

每一张卡住的单写的是：

```
masters not opened, document not sent: error code: 502
```

**这句话是假的。** ERP **没有叫 AutoCount 打开任何主档** —— 请求根本没有到那台机器。

- **发现:** 2026-08-23
- **状态:** 已修

### 真相

`error code: 502` 是 **Cloudflare 对「连不到来源」的纯文字回应**。在 ERP 之外直接验证：

```
$ curl -i https://autocount.houzscentury.com/health
HTTP/2 502
server: cloudflare
content-type: text/plain     （16 bytes = error code: 502）
0.06 秒
```

**而且是 502 不是 1033** —— Cloudflare Tunnel **没有连线**才回 1033。回 502 代表
**通道连着，但它转发的那个服务没有回应**。0.06 秒也印证这点：快到代表没有等任何东西。

所以：`cloudflared` 在跑，**它後面那个听 `http://localhost:<port>/` 的 AcSyncService
没有回应**。

### 为什么会被讲成主档问题

`callAcService` 在回应**不是 JSON** 的时候，把**整个原始 body** 当成错误讯息：

```ts
const error = body.error ?? (text || `AutoCount service responded ${res.status}`);
```

而 `ensure_masters` 是每次送单的**第一个呼叫**，所以那串字被包进「masters not opened,
document not sent: …」里，一路送到操作者的画面上。

### 代价

**一整天。** 这句话把调查方向指向 AutoCount 的登入和主档资料，而真正的问题是一个**停掉
的 Windows 服务**。

一句指错子系统的讯息，不只是「没帮上忙」—— **它会把人送去错的地方。**

### 修法

**闸道状态 + 非 JSON 的 body = 只有一个意思，现在就讲那个意思。**

```
the AutoCount host did not answer (HTTP 502) — the request never reached it,
so nothing was refused and nothing was opened. Check that the sync service is
running on that machine; https://autocount.houzscentury.com/health answers 200
when it is.
```

**服务自己讲的话不动**：闸道状态但带 JSON `error` 的，是 AutoCount 在讲话，保留原话。

分类新增 `host-unreachable`，而且**排在 `masters-not-opened` 前面** —— 存下来的句子会
同时含两个 needle，交通那个必须赢。

### 测试

两个方向都钉：**机器没回应要讲对**，而**真正的主档失败还是主档失败**。

另外钉了顺序：那句话同时含两个 needle，所以「排在前面」不是排版，是规则。

先证明 RED：8 个案例挂 5 个（另外 3 个是「不该改的别改」，本来就绿）。

### 两个闸门抓到我漏的

- **`autocountOutboxStatus.canonical`** —— 这张表有一份 `.mjs` 镜像给 node 用的健康
  检查。少更新一边就是同一条规则有两个家。
- **`autocountSyncReasonsCatalogue`** —— 每一个分类都必须在
  `docs/autocount-sync-reasons.md` 里有一列。新增分类而不写文件会被挡下来。

两个都补齐了。

### 这支**不会**让单据进得去

那台机器还是没回应。**这支修的是「画面讲不讲实话」** —— 让下一个人不用再花一天才找到
真正的地方。

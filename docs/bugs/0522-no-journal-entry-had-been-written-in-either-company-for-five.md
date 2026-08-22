## No journal entry had been written in either company for five days [critical]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 从 **2026-08-18** 起，**两家公司的总帐一笔分录都没有再写出来过**。销售发票、
采购发票、付款传票、每一笔冲销 —— 全部在同一行丢例外，而且没被接住。

单据本身已经 POSTED，画面却跟操作的人说「Something went wrong」。**帐已经开了，帐本
是空的。**

- **发现:** 2026-08-23，在 prod 走完一次完整 SO → PO → GRN → PI 之后
- **状态:** 已修

### 现场

在 Houzs Century 走真实画面开出 `HC-PI-2608-004`：

```
POST  /api/scm/purchase-invoices          201   {"invoiceNumber":"HC-PI-2608-004"}
PATCH /api/scm/purchase-invoices/{id}/post 500  {"error":"Something went wrong. Please try again."}
```

那个 body 是 `index.ts` 最后一层 fallback —— 代表错误讯息**既不像 Postgres 错误、
也不是连线问题**。是 **JavaScript 例外**。

### 那一行

`scm/lib/doc-no.ts`，`jePrefixForCompany`：

```ts
const { data, error } = await sb
  .from('companies')        // ← scm client 钉在 scm schema
  .select('code')
  .eq('id', companyId)
  .maybeSingle();
if (error) throw new Error(`jePrefixForCompany: could not read company ...`);
```

| | |
|---|---|
| SCM client 钉的 schema | `scm`（`db/supabase.ts:77`）|
| 所以 `from('companies')` 解析成 | **`scm.companies`** |
| `scm.companies` 在 migration 里 | **0 次 —— 它不存在** |
| `public.companies` | 34 次 —— 真正的主档 |
| 全后端做 `from('companies')` 的地方 | **只有这一处** |

读失败 → fail-closed 的 throw **每一次都会开火**，每家公司都一样。

### 为什么没有人发现

这是整个后端**唯一**用 PostgREST client 读 companies 的地方；其他每个地方都是走
raw SQL（`middleware/companyContext.ts:120`）。**没有第二个呼叫点可以跟它不一致。**

而且 throw 的位置很关键 —— 它在单据已经翻成 POSTED **之后**。所以：

- 单据看起来是好的
- 帐本是空的
- 画面报的是一句什么都没讲的话

三个讯号各自都不够刺眼。

### 什么时候开始的

**PR #2427，2026-08-18。** 那次把一个纯运算式

```ts
Number(companyId) === 1 ? '' : '2990-'
```

换成了**读资料库 + fail-closed 丢例外**。

**用意是对的** —— `companies.id` 在 staging 和 prod 不一样，写死 id 会让文件编号落到
错的公司序号里。错的只是那一行读了不存在的表。

### 量到的代价

2990 的总帐（只读查看）：**11 笔分录，最新一笔 15/08/2026**。这个改动 **18/08** 上线。

**从那天起，没有再多一笔。**

Houzs Century：**0 笔**。AR 自检抓得到 `HC-SI-2608-002`「document has no active
journal」；AP 那半边抓不到，因为它有另一个盲点（`docs/bugs/0518`）。

### 修法（两半，缺一不可）

**一、读对 schema。**

```ts
await sb.schema('public').from('companies')...
```

**二、把例外关在里面。**

`jePrefixForCompany` **应该** fail closed —— 用错前缀去 mint 会让两家公司的流水号
相撞，那比不过帐更糟。

但**「让例外逃出去」跟「fail closed」不是同一件事**。逃出去的结果是：单据已经
POSTED、帐本空的、操作的人拿到一句没有原因的话。

`postJournal` 现在把它转成 `je_prefix_failed` —— 跟这个函式里其他每一种失败一样的
结构化拒绝。呼叫端会记 log 记原因，稽核纪录也会写下 AP/GL 没有过成。

### 测试

两半都钉住，因为**只钉一半，另一半就还留着**：

1. 读的时候有指名 `public` schema
2. `postJournal` 会包住那个 throw，回结构化的拒绝＋原因

`fake-postgrest` 学会了 `.schema()`（会记录被要求的 schema，所以测试能真的断言）。
production 的程式码本来就会跨 schema，fake 不会的话，测的就是 fake 不是程式码。

先证明 RED：3 个案例挂 —— 正好是修复的两半。既有 **1909** 个测试全过。

### 相关

- `docs/bugs/0518` — AP 自检看不到没有分录的已确认采购发票。同一天发现，不同的洞：
  一个让帐记不进去，一个让「帐没记进去」看不出来。

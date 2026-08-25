## Hookka and Ohana sofa bindings held our own code, so the purchase order named another supplier's model [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板 2026-08-25:「之前 hookka 的 code 开错了」、「hookka 的 9028 换 5530 /
8030 换 5540 / 9058 换 5536」。

**他是对的,而且切换上线的快照证明了。** AutoCount 帐本里:

```
AMN-SF9028 SOFA · DSL-9028 SOFA   ← ARMANI / DORSETTLOFT 的
AMN-SF9058      · DSL-9058
DSL-8030 SOFA                     ← DORSETTLOFT 的
HOK-5530 / 5535 / 5536 / 5540 / 5543 SOFA   ← Hookka 自己的
```

**`9028` / `9058` / `8030` 在帐本里从来不是 Hookka 的型号。** 所以一张开给 Hookka 的
采购单印出 `9028-1A(LHF)`,是拿**别家的型号**去叫 Hookka 做。

**binding 功能本身是好的,而且正在用。** 量过 HOOKKA MANUFACTURING 的 91 笔:
**50 笔有真正的供应商码**(`ARIZONA (A)-(SK)` → `HOK-1019 (SK)`),41 笔存的是我们自己
的码 —— 而那 41 笔**全部是沙发**,床架一笔都没有这个问题。

**为什么偏偏是沙发。** 那一栏同时被 AutoCount 写回读(docs/bugs/0537)。有人为了让
AutoCount 那边解析得到,把沙发那几笔填成 ERP 自己的码 —— **牺牲了采购单来迁就帐本**。

**所以改这一栏不是单纯的资料订正。** 它同时改变写进正版帐本的料号,这就是为什么这支
工具**预设只做预演**,而且对每一笔都用真正的 `resolveAcItemCode` 印出「AutoCount 会
收到什么」以及「帐本有没有这个码」。

**格式是老板选的,另一个选项也记下来了。** 平换(`9028-1A(LHF)` → `5530-1A(LHF)`)
对上帐本自己的写法(`HOK-5530 SOFA 1A(LHF)`,Hookka 有三笔已经是这样)两个并排给他看
过,他选了平换。代价写在 plan 的输出里:平换的写法帐本没有,会印
`[NOT in book — would be OPENED]`。

```enumeration
backend/scripts/hookka-sofa-sku-backfill.mjs — plan/apply，plan 会算出帐本会收到什么
.github/workflows/hookka-sofa-sku-backfill.yml — 手动触发，预设 plan
```

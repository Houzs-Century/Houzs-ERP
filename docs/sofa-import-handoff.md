# 沙发 SO/PO 导入 — 交接文档 (Sofa cutover handoff)

**给下一个 session 的一句话**:AutoCount 一行沙发 = ERP 多行(每个 compartment 一行)。
这份文件讲清楚三件事:**怎么读懂 Desc2 的写法**、**件的码怎么定怎么开**、**整条导入管线怎么跑**。
所有规则都是 owner 2026-08-09/10 亲口定的,原话保留在下面,改规则前先看这里。

状态(2026-08-10):**SO 已全部导入并体检通过**;PO 已导 37 张,还缺 61 行(见 §8);照片未进(见 §8)。
**沙发一台都发不出去的两个原因(库存从没进 + SO 行没有 warehouse)看 §8.0,两个修都只跑过 dry-run。**

---

## 1. 一句话架构

```
AutoCount SODTL 一行沙发
   │  ItemCode ("DSL-8030 SOFA")  → 对照表 → ERP 型号 ("8030")
   │  Desc2    ("1+C+2(28'INCH)/COL:KIV") → 语法解析(§2)
   ▼
ERP scm.mfg_sales_order_items 多行
   8030-1A(LHF)   ← 价格挂这一行
   8030-CNR       ← 0 元
   8030-2A(RHF)   ← 0 元
```

金额永远不变:**价格挂头一件,其余 0 元**,所以 ERP 单据总额跟 AutoCount 分毫不差。

**核心代码**:`backend/scripts/lib/parse-sofa.mjs`(SO 和 PO 共用,唯一真源,别复制)。

---

## 2. Desc2 语法(owner 亲定,每条都有出处)

### 2.1 总纲

> **"一套沙发只有左右两个闭端"**、**"中间不可能有扶手"**(owner 2026-08-10)

一台沙发就是一排件,**只有最左和最右两个位置有扶手**,中间一律无扶手(NA)。
token 的书写顺序 = 面对沙发时的实际摆位。解析器最后有一道**物理归位**:写在中排的
带扶手件,会跟端头的无扶手件对调(`2NA+1R+L` → `1A(R)左 + 2NA + L右`)。

### 2.2 件的写法

| 写法 | 意思 | 出处 |
|---|---|---|
| `1S` / `2S` / `3S` | 整张 1/2/3 座(两端都有扶手) | — |
| `1A` / `2A` | 一个位 / 两个位,**带一个扶手** | owner:"我们沙发有分一个位一个扶手和两个位一个扶手" |
| `1NA` / `2NA` | 无扶手 | — |
| `1EL` / `1ER` / `2EL` / `2ER` | E = 扶手在左/右 → `1A(LHF)` / `1A(RHF)` / `2A(...)` | owner:"EL 或 ER 代表左边或右边" |
| `L` | 贵妃(chaise) | — |
| `C` / `1C` / `CNR` / `CORNER` | 角位 | owner:"1c 是 corner" |
| `CT` / `C/T` / `CS` / `CONSOLE` / `C TABLE` | Console(中间小几) | owner:"CS 就是 console" |
| `1B` / `2B` | Bench(**不做扶手**),**分左右** `1B(LHF)/1B(RHF)` | owner:"Bench 就是不做扶手";"1b 要分","2b 也是有的" |
| `NA/LT` `NA/RT` | **1ABOX(LHF) / 1ABOX(RHF)** | owner:"1NA/LT 开 1ABOX(LHF) and 1ABOX(RHF)" |
| `P` / `1AP` | 电动位 `1S(P)` / `1A(P)(side)` | — |
| `R` / `1R` | recliner `1S(R)` / `1A(R)(side)` | owner:"1R 现在是 1AR";"2379 很多 1r 就是 1s r" |
| `STOOL` | 脚凳 | — |

### 2.3 组合与拆分规则

| 原文 | 解成 | 出处 |
|---|---|---|
| `1+1` | `1A(左) + 1A(右)` | owner:"1A+1A=1+1" |
| `1+C+2` | `1A(左) + CNR + 2A(右)` | owner:"1+C+2 就是 1A+corner+2A" |
| `2s + C + 1s` | `2A(左) + CNR + 1A(右)` | owner:"这个是 corner 来的 2A+C+1A" |
| `2S+L` / `2+L` | `2A(左) + L(右)` | owner:"这个也是 2A+L" |
| `2L` | `L(右) + 2A(左)`(座在左、贵妃在右) | owner 2026-08-09 |
| `L2` | `L(左) + 2A(右)` | 同上镜像 |
| `2R+1L` | `2A + L`(1L 并排时就是一张贵妃) | owner:"这个事 2A+L 啊" |
| `1+2+3` / `R+2+3` | **成套**:`1S+2S+3S` / `1S(R)+2S+3S`(不是连排) | owner:"1-2-3 其实就是 1-seater 加 2-seater 加 3-seater" |
| `2+1S` | `2S + 1S`(套装) | owner:"这个是 2S + 1S 来的" |
| `3S`(座深 ≠24") | **拆成 `2A + 1A`** | owner:"3s 都是[拆] 除非 seat size 24" |
| `3S`(座深 =24") | 保留整张 `3S` | 同上 |
| `4S` | `2A + 2A` | owner:"4S 就是 2A 加 2A 来的" |
| `2.5S` / `2.5` | **就是 `2S`**,只是尺寸大 | owner:"2S 跟 2.5S 是一样的…以前尺寸比较大" |
| `2S + console` | **拆开** `1A + Console + 1A` | owner:"2s+console 一定分开的 1A+1A,console 才能放中间" |
| `3S + console` | `2A + Console + 1A` | 同上延伸 |
| `2R(1+1)` / `2 seater (1EL+1ER)` | **括号里的明细为准** = `1A+1A` | owner:"它 bracket 嘛,所以 by right 它应该是 1A 加 1A only" |
| `3R`(有 recliner 的款) | `1A(R) + 2A` | owner:"3R 就是有 recliner" |
| `3RR` | `1A(R) + 1NA + 1A(R)` | owner:"3RR 是 1AR+1NA+1AR" |
| `2PP` / `3PP` | 同上,P 版(有 R 必有 P) | owner 2026-08-09 |
| `2G1F` | `2A + CNR + 1A` | owner:"2G1F 也是 corner 来的" |
| `L shape` | 当 `2L` 处理,左右先随便放 | owner:"L-shape 其实就是 2L…你随便帮它放一个先" |
| 单写 `Corner` | 卖的是整套 corner set = `2A + CNR + 1A` | owner:"这种 corner 都是 2A+C+1A" |
| 单件 `1ER` / `2ER` | 就是整张 `1S` / `2S` | owner:"1ER 如果只是一个 compartment,一定是一座" |

### 2.4 型号决定 R 的含义(很重要)

> **8030 / 8060 / 9058 / 9028 / 9050 / 8069 / 5535 没有电动、没有 recliner**(owner 2026-08-10)

解析器**按型号实际开了哪些件**判断(探测 `{型号}-1S(R)`、`-1A(R)(LHF)`、`-1A(P)(LHF)`、`-1S(P)` 是否存在):

- 有 R/P 件的款:`R` = recliner
- 没有的款:`R` = **右边(RHF)**。例:`1R+2R`(8060)= `1A(左) + 2A(右)`;单写 `2R`(8030)= `2S`
- 没 recliner 的款却写了 "recliner" 字样 → **不硬解**,标"请核对"

### 2.5 座深 / 颜色 / 脚 / special order

- **座深**:认 `28"`、`28'`、`35”`、`30'INCH`、`60cm`(=24")、`70cm`(=28")、`Size: 28`;
  笔误 `icnh`/`inhc`/`ich` 一律当 `inch`(救回过 PROC 单)。多个不同尺寸 → 标「多尺寸分件」
- **脚**:带 `leg` 的整句**先摘出来当 special order**,绝不能被当成座深
  (`Leg Change 101Middle Leg(8')` 里的 8' 是脚高)。没写脚 = 用默认(owner:"脚全部找不到就直接选 default")。
  **导入器从来没写过 `variants.legHeight`**,所以已导入的行脚位是空的 —— 补法见 §7 的
  `backfill-sofa-leg-default.mjs`:只补两个 key 都空的行,**原文写了脚的不补**,单独列出来等人挑
  **但这一句往回抓到哪里为止,是有边界的**(2026-09-02 修):以前两边都是「除了 / 和换行以外什么都吃」,
  也就是**整个 slash 段**,所以脚的备注写在件表**后面同一段**时,件表跟着被删掉,整行掉回
  `{model}-1S` 占位 —— `2+C+1(35'INCH)FULLY COVER NO LEG` 就是这样丢的(HC-SO-011755)。
  现在往回抓遇到 `+` 或 `)` 就停:件表只会以这两个字符收尾,所以书里现有的 20 种写法
  一种都没变,只有坏掉的那一条变了。同一类的坑见 `docs/bugs/0001-a-bare-c-corner-was-filtered-as-noise-so-49-sofa-builds-lost.md`(NOISE 吞掉裸 C / 裸 R)
- **颜色**:`COL:` / `Colour:` / `COL-`,支持分件颜色 `colour (2s): X`;
  `TBC` / `KIV` = 还没选,留空不算错
- **special order**:nylon 底、伞布、`backrest change to 8030`、`fully cover replace the leg`
  等等一律进 specials 跟着行走;**会改结构的**(WOODEN ARM、ARM CHANGE TO SEAT AREA)不自动解,占位等人工
- **special order 的收集是独立的一趟**(2026-08-10 修):`parseSofa` 在**任何删改之前**
  先扫一遍原文,按 slash / 换行 / `*` 切块,块里带 special 词表就整块**原文**进 `specials`。
  为什么要独立:`bottom[^\/\n]*` 会把整段删掉——53 条 `bottom use umbrella fabric`
  因此一条都没进 ERP;而 rider 那条路只看得到**带结构的那一段**,单独成段的
  `/BACK CUSHION CHANGE 8030` 同样丢。这趟只写 `specials`,件和 confidence 一个字不动
- **落到单上**:`backfill-sofa-special-orders.mjs` 把 specials 对回 `scm.special_addons`
  的 picker code(owner:"全部 match 回来 picker listing,没有的才用 customs others
  写进去")。picker 是**现场读**的,不写死;规则里的 code 库里没有就整条走自由文本,
  绝不映射到不存在的 code。owner 已定的等价:nylon = 伞布 → `Nylon Fabric`;
  `fully cover to floor no leg` / `fully cover replace the leg` / `extend to floor
  with 1 inch leg` → `Seat Base Fully Cover with no Leg`;`after push back align to
  seat` → `Seat Behind Extend 5"`;`seat cushion add height 1 inch` **故意没有 code**,
  走自由文本。Altay Leg 已经搬去 leg pool,所以换脚的句子也不映射
- **这支不能盲目再跑一次**(2026-08-13 修):它写的是旧的 `string[]` 形状,而
  `custom_specials` 宣告的形状是 `Array<{ description, surchargeSen }>`
  (`mfg-pricing-recompute.ts:117`),定价引擎一改行就写后者。第二趟碰到已经
  recompute 过的行,`String(物件)` 会把整栏写成 `["[object Object]"]`——把带钱的
  surcharge 明细换成一个占位字串。现在这种行会被**拒绝并列印**,报表那行叫
  `lines REFUSED because the pricing engine already owns their custom_specials`。
  其余的行第二趟会推出同样的联集,是空转

### 2.6 铁律

1. **不确定就不猜**。解不出 → 占位 + 写明原因(§5)
2. **左右不确定可以先放,之后让他们改**(owner 2026-08-10),但一定标「看图定」
3. 已 proceed / 已开 PO 的单:**compartment 必须对**,颜色和座深也要确认;
   未 proceed 的单缺颜色缺座深**不用审**(owner:"那些当他们 proceed 单的时候,他们会补掉的")

---

## 3. 件的码怎么定、怎么开

### 3.1 码的长相

```
{型号}-{compartment}      例:8030-1A(LHF)、9058-CNR、822-1ABOX(RHF)
```

型号来自对照表 `backend/scripts/data/autocount-erp-mapping-1561.csv`(AutoCount 码 → ERP 码),
再套别名表:`5530→9028`、`5536→9058`、`5537/5540→8030`(owner:"5530 就是 9028")。

SKU 名字格式:`SOFA {型号名} {件}`(不带品牌前缀)。

### 3.2 开件的三个动作(缺一不可)

1. `scm.product_models.allowed_options.compartments` 加上这个件 ← **开关的唯一真源**
2. `scm.mfg_products` 铸出 `{型号}-{件}` 这个 SKU
3. `maintenance_config_history.config.sofaCompartments` 池子里补上这个件码(**append-only,新增一行,不要改旧行**)

现成脚本:`backend/scripts/open-sofa-so-compartments.mjs` + workflow(dry-run 默认,apply 要确认语)。

### 3.3 怎么知道要开什么

跑一次导入 dry-run,日志里会出现 `piece SKU missing: 8030-1A(R)(LHF),...` —— 那就是清单。
本轮据此开了两批 53 个件(2S、扶手对、recliner/power 对、Bench、1ABOX、7223-CNR)。

**教训**:第二批一度给 8030/8060/9058/9028/9050/8069/5535 开了 recliner/power 件,
owner 指出这些款根本没有 → 已用 `revert-sofa-recliner-skus.mjs` 撤掉 28 个。**开件前先问型号有没有这个机构**。

### 3.4 型号本身缺了怎么办 —— 对照表的 `EXISTS(1st-pass)` 会吃掉一个型号

`piece SKU not minted` 有两种成因:件没开(§3.3),或者**整个型号从来没建**。
后者的根在对照表:`RDS-5526 SOFA` 那行原本写 `8038-1S / EXISTS(1st-pass)` —— 名字都叫
DISCOVERY 的一次模糊匹配,但供应商一个是 `400-R001`(RED SOFA)一个是 `400-D004`(DSL)。
importer 是从对照表的 `-1S` 反推型号的(`erp.replace(/-1S$/,"")`),所以 5526 没拿到
`scm.product_models` 行,九条单据行全落在 8038 上。owner 2026-08-10:**"5526 就是 5526 啊,
你应该要 remain … 8038 原本都不是 5526."**

修:`open-5526-model.mjs` + 同名 workflow —— 建型号(`name` 用型号码本身,跟
`align-models-houzs-century.json` 给 5527/8133 的写法一致;**不要**沿用 DISCOVERY,那正是
出事的原因)、开件、铸 SKU、补池子,再把九条行从 `8038-*` 改到 `5526-*`,并顺着
SO→PO→GRN、SO→DO 带下去。**金额一分不动**(只改 code 和名字,脚本逐单核对总额)。

**留给 owner 决定的**:供应商绑定没动。`8038-1A(LHF)/1NA/2A(RHF)/CNR/Console/STOOL` 的
`supplier_sku` 全是 `RDS-5526 SOFA`,`8038-1S` 还是 RED SOFA 对它的 main binding —— 一动就动价。

**对照表里还有 318 行 `EXISTS(1st-pass)`**,都是同一类机器猜测。碰到"型号不见了"先看这一列,
再看 supplier 列对不对得上。

---

## 4. 颜色怎么对上布料库

`scm.fabric_colours`(PK = `fabric_id` + `colour_id`,`fabric_id` 外键指向 `fabric_library`)。

比对分三层,**精确优先,有歧义宁可不认**:

1. 精确:色号 / 名称 原样命中
2. 折叠:字母重复收敛(`BOO315`→`BO315`)、`O→0`、去材质词(leather/lether/fabric/velvet)、
   开头整段重复收敛(`BOOBOO315`→`BO315`);**数字重复绝不收敛**(`BO315-11` 不能折成 `BO315-1`);
   两条库记录折成同一个 key → 这个 key 直接丢弃,不匹配
3. 最长前缀 + 一次换位(`grafield1`→`GARFIELD1`),同样要求唯一

**本轮发现**:25 行 PROC 单的颜色库里真的没有(不是比对问题)。已用
`add-missing-sofa-fabrics.mjs` 建了 6 个系列 / 19 个色号(MODENZA 02/06/07、GD2502 三色、
HR805-31/-40、NX007/010/011、ZL-6/-20、Garfield、Wowsons、Chantic、J9883-2、J9226-2、M2402-8)。

---

## 5. 解不出的怎么办(owner 选的方案 A)

单**照样进**,不丢单不丢钱:

- SKU 先放 `{型号}-1S`(真实存在的码,单据才合法),**金额挂这一行**
- 行备注写 `SOFA UNPARSED — 按图/原文补件: <原因>`
- AutoCount 原文整段留在 `description2`
- 解出来的部分照带(有座深就有座深,颜色对上库就绑)
- 操作员打开单,把占位换成真正的件即可(件都开好了,picker 里选得到)

**别把这个占位当 bug**:它是刻意的,`SOFA UNPARSED` 就是它的签名。
体检脚本靠这个签名 + 修复脚本的 `补拆件` 签名来区分"占位"和"真漏拆"。

---

## 6. Outstanding 的定义(owner 亲定,踩过坑)

> **"outstanding 指的是还没有转成 DO"**、**"如果 convert to PO,它其实依然算作 outstanding"**
> (owner 2026-08-10,并特别说明"之前我们也有犯过这个错误")

- **SO**:整单每一行都 `TransferedQty >= Qty` = 已交货 → **不导**。
  `TransferedPOQty` **一次都不看**,转 PO 永远不会让单被排除。
  已写进 `import-ac-outstanding-so.mjs`(`ALLOW_DELIVERED=1` 可还原旧行为做对比)
- **PO**:**不套用 DO 规则**。已收货的 PO 照样导——货在仓、客人还没拿到,单子必须在系统里
  (owner:"他虽然收了货,可是 SO 还没有送货出去,所以才需要进来")
- **取消的单**:不用管(owner:"Cancel 的不要紧")

**本轮修正**:92 张已交货的单被误导入 → 删了 91 张(连同这次导入自己带的付款记录),
1 张因为付款是人工补录的,留住给 owner 定。判定用的是付款的来源签名
(`method='imported'` + `note LIKE 'imported from AutoCount%'`)。

---

## 7. 管线与工具(全部 gated:dry-run 默认,apply 要确认语)

| 用途 | 脚本 | workflow |
|---|---|---|
| SO 导入(沙发用 `sofa=yes`) | `import-ac-outstanding-so.mjs` | `import-ac-outstanding-so.yml` |
| PO 导入(沙发用 `sofa=yes`) | `import-ac-outstanding-po.mjs` | `import-ac-outstanding-po.yml` |
| 开件 | `open-sofa-so-compartments.mjs` | 同名 yml |
| **建型号 + 开件 + 改单据行**(5526) | `open-5526-model.mjs` | 同名 yml |
| 撤错开的 R/P 件 | `revert-sofa-recliner-skus.mjs` | 同名 yml |
| Bench 改分左右 | `fix-bench-sides.mjs` | 同名 yml |
| 建缺的布料 | `add-missing-sofa-fabrics.mjs` | 同名 yml |
| 补漏拆的旧行 | `repair-leaked-sofa-lines.mjs` | 同名 yml |
| 删已交货误导入 | `remove-delivered-imported-so.mjs` | 同名 yml |
| 成本补盖 | `restamp-imported-so-costs.mjs` | 同名 yml |
| 布料库探针(只读) | `probe-fabric-colours.mjs` | 同名 yml |
| **导入后体检(只读)** | `probe-sofa-import-duplicates.mjs` | 同名 yml |
| 行照片挂载 | `import-so-line-photos.mjs` | 同名 yml |
| **沙发实物库存开账** | `import-ac-sofa-stock.mjs` | 同名 yml |
| **补 SO 行的 warehouse** | `backfill-so-line-warehouse.mjs` | 同名 yml |
| **special order 落到 SO/PO 行** | `backfill-sofa-special-orders.mjs` | 同名 yml |
| **补脚高 = Default(见 2.5)** | `backfill-sofa-leg-default.mjs` | 同名 yml |

### 体检脚本的 7 项

1. 重复单头(同一张 AC 单变两张 ERP 单)
2. 重复行(某码出现次数超过 AutoCount)
3. 漏拆(粗判)
4. 行数偏差(拆件本来就会多行,正常)
5. **已交 DO 却被导入**
6. **转 PO 未转 DO 的有没有漏进**
7. **真漏拆 vs 正常占位**(靠备注签名区分)

改动之后一定重跑这个脚本;`gh run view <id> --log` 里 `##[notice]` 就是报告。

### 改解析器的规矩

`parse-sofa.mjs` 里累积了 40+ 条 owner 判例。改之前:
1. 拿 `ac-outstanding-so.json.gz` 跑全量回归,比对改动前后(升级/降级/改判各多少)
2. **零意外降级**才能提交;有降级要逐条看懂
3. owner 给的每个新例子都补成金标测试

回归要连 `ac-outstanding-po.json.gz` + `ac-so-linked-pos.json.gz` 一起跑,两个
recliner 状态都跑 = 716 行 x 2。**比对 specials 时要按词元比,不能按字符串比**:
座深清理会把 `EXTEND TO FLOOR WITH 1'INCH LEG` 啃成 `EXTEND TO FLOOR WITH 1  LEG`,
按字符串看像是丢了,其实是同一句的完整版顶掉了残缺版。

---

## 8. 还没做完的(下一个 session 接手)

### 8.0 沙发为什么一张都发不出去 —— 2026-08-10 查清,两个原因不是一个

沙发 SO 行全部 PENDING,**不是**一个问题,是两个叠在一起。两个都只跑过 DRY-RUN,**都还没 apply**。

**原因一:沙发实物库存从来没进过 ERP。**
`import-ac-stock-balance.mjs:54` 的 `!isSofa(ItemCode)` 把沙发整个排掉了(层重铺 `:50` 同样)。
prod 只有 20 个 open sofa lot,而且 **batch_no 全是 NULL** —— 沙发配货三处都读 `batch_no`
(`findCoveringBatch`、DO 闸门、`loadSofaBatchStock` 直接 `batch_no IS NOT NULL`),没有 batch 就等于没有货。
AutoCount 那边是 76 台整沙发。修:`import-ac-sofa-stock.mjs`。

**沙发的 batch_no 应该是什么 —— 结论 + 证据。**
= **那张 PO 自己的 ERP `po_number`**。理由不是约定,是三处现成代码都这么说:GRN 就是这么盖的
(`grns.ts resolvePoBatchByItem` → `purchase_orders.po_number`,mig 0120);`sofa-set-coverage.ts`
开头写死「batch_no = source PO number = one dye lot」;`source-po-trace.ts` 把它当 Source PO 芯片渲染。
AutoCount **自己没有 batch**(实测 `GRDTL.BatchNo` 1,337 行沙发**全空**,`SerialNoList` 也全空),
所以只能从单据推,而 PO 就是那个「一张单 = 一个染缸」的单位。ERP 的 PO 行上有 `linked_ac_docno`,
一跳就能回到 AutoCount 原单号,追溯不丢。

**整沙发余额能不能拆成 compartment —— 不能,也不需要。**
AutoCount 的 `vItemBalQty` 只有「AMN-SF9028 SOFA 在 KL 有 6 台」,**没有配置、没有序号、没有批次**。
6 台是 6 个**不同的 build**,快照说不出是哪 6 个。**照余额行拆件 = 编库存**,不做。
真正的做法是**不拆余额,改走单据**:每台在手沙发都是订制的(97 条 GR 行里 94 条的 PO 带
`FromSODtlKey`),这些 PO 已经被 `import-ac-so-linked-pos.mjs` 带 `received_qty` 导进来、
**已经按 parse-sofa 拆好件**、已经认领了 SO 行。一条 `received_qty > 0` 的沙发 PO 行 = 一件实物,
按它开 lot 即可,余额只当**上限**用(按 AutoCount item code 封顶,超的丢掉并逐条打印)。
解不出件的 `SOFA UNPARSED` 占位 build **默认不开库存**(`PLACEHOLDER=1` 才开)——
用 `{型号}-1S` 顶一台其实是双人位的沙发,那是一个**错的库存数**,比缺货更糟。
展厅 display 那几台(没有 PO,Desc2 就写 `DISPLAY REF: ADJ0052/00148`)同理:只报,不开。

**原因二(更要命):导入的 SO 行一条都没有 warehouse。**
13,881 行导入 SO 行,`warehouse_id` **全是 NULL**(`import-ac-outstanding-so.mjs` 算了却没写进
`ICOLS`)。库存按 warehouse 分桶,沙发更早一步就死:`findCoveringBatch` 见到 null warehouse
**先返回 null 再谈库存**。所以**光补库存一套都变不了 READY**。修:`backfill-so-line-warehouse.mjs`。

**DRY-RUN 实测(2026-08-10,prod 只读):**

| | 数字 |
|---|---|
| 会开的 lot | **97 lots / 97 units / 43 个 batch**(45 个 build) |
| 丢弃 | 超 AutoCount 余额 **4**、占位 **9**、缺 warehouse **0** |
| AutoCount 有、单据背不了的 | **31 units**(展厅 display + SO 已交货的收货) |
| 成本 | 拿到真实收货价 **13** build;收货价互相矛盾 **3**;找不到 **29**(留 0,不猜) |
| 只补库存 | **0 套 / 0 行**变 READY |
| 补库存 **+** 补 warehouse | **30 套 / 70 行**变 READY |


### 8.1 照片(Further Description)— **已完成 2026-08-10**,本节保留作历史

> **这一节下面的「卡点」已经不成立了。** 那批 jpg 一直在开发机的 scratchpad 里;
> 2026-08-10 已经全部传进 R2 并挂上:**SO 983 个 key(逐个查过 R2,0 缺)、PO 242 个 key**。
> 对 live `AED_HOUZS` 逐条核对过:SO 端 554 行有图、全部抽出;PO 端 190 张(比原本多 16 张,
> 原因见 `BUG-HISTORY.md` 的「scope」与「\pichgoal」两条)。
> 现在还挂不上的只剩:**SO 18 张在已交货单上**(按 DO 规则不导,正确)+ **PO 36 张的单本身没导进来**(见 §8.2)。
> 缩略图曾经全是 `err`,那是 `SO_ITEM_PHOTOS_BUCKET_NAME` 没配,不是没上传 —— 已修。

- AutoCount 每张沙发单的 Further Description 里有实拍图,**图里能看出件和左右**
- 图已经在 AutoCount 主机上抽成 jpg(档名 `SO-xxxxx__<DtlKey>_<n>.jpg`),
  清单在 `backend/scripts/data/ac-photo-manifest.json.gz`(544 张,沙发 377 张 / 354 单)
- **但档案从来没上传到 R2**,所以 ERP 里缩略图显示 `err`
- 通道已经铺好:`import-so-line-photos.mjs` 现在**支持沙发**——一张沙发的图会自动挂到
  它拆出来的**每一个 compartment 行**上
- **卡点**:这台开发机拿不到那批 jpg(本机、repo、git 历史、Actions artifact、导出 JSON 全查过;
  中间件 `it-houzs.dev` 回 401 而且明细接口不带 FurtherDescription;直连 DB 要 ZeroTier)
- **要做**:拿到那批 jpg → `wrangler` 传进 `houzs-erp` bucket(key 用脚本 RESOLVE 模式印出来的)
  → `APPLY=1` 挂上 photo_urls

### 8.2 PO 补导 61 行

- 沙发行有 122 行标着"已转 PO",PO 导出档里只覆盖 61 行
- 少的那 61 行(57 张 SO)是**整张 PO 已收完货**,被 AutoCount 的"未收货"导出条件筛掉了
- 但按 §6 的规则它们必须进来(SO 还没送货)
- **要做**:在 AutoCount 主机跑 `AutoCount-补导PO.sql`(条件已改成"关联的 SO 还没转 DO 就导"),
  导出的档案格式跟 `ac-outstanding-po.json.gz` 对得上,直接进现有通道

### 8.3 PROC 单还剩 25 行要人写

19 行原文没写件(只写了颜色/工艺,要看图)、6 行没写座深。清单在会话里发过 CSV。

### 8.4 HC-SO-000814 少了整条沙发行(2026-08-10 dry-run 查到,**没人动过**)

`open-5526-model.mjs` 的 prod dry-run 报:`HC-SO-000814 ... 0 sofa line(s) ...
document lines: accessory:1`。单在 ERP 里,但**只剩一条 accessory 行**(RDS-SQUARE
PILLOW),AutoCount 那条 `RDS-5526 SOFA`(DtlKey 58980,**UnitPrice 9,300**)不在。

- 那条行 `TransferedQty 1 >= Qty 1`(已交货),但**整单**没交完(pillow 还欠 2),
  按 §6 的 owner 规则整单该导、行也该在
- importer 没有「逐行跳过已交货」的分支,`skipMixed` 又是整单跳,所以**不是导入时漏的那么简单**——
  可能是后来某个清理/修复脚本删掉的。**没查出来,别猜**
- 影响:这张 ERP 单的金额比 AutoCount 少 9,300。**先核对单头总额**再决定补行还是重导
- 五个 5526 的 SO/PO 都对得上,只有这一条不在;`open-5526-model.mjs` 遇到它是 skip,不会瞎补

### 8.5 其他

- 89 行占位(含标记)等人工补件
- 1 张已交货单留着没删(付款是人工录的)
- 620 行的成本没盖上,因为产品本身还没有厂价
- **5526 的供应商绑定没动**(见 §3.4):六个 8038 件的 `supplier_sku` 还是
  `RDS-5526 SOFA`,`8038-1S` 还是 RED SOFA 的 main binding —— 等 owner 定

---

## 9. 一句话铁律

1. **不确定就不猜**——宁可占位 + 标记,也不要写一个看起来对的件
2. **金额永远不动**——拆件是把一行变多行,总额必须一样
3. **prod 先 dry-run**,数字对得上才 apply
4. **owner 的原话就是规范**,这份文件里的引用不要改写

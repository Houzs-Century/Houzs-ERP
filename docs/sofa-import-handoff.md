# 沙发 SO/PO 导入 — 交接文档 (Sofa cutover handoff)

**给下一个 session 的一句话**:AutoCount 一行沙发 = ERP 多行(每个 compartment 一行)。
这份文件讲清楚三件事:**怎么读懂 Desc2 的写法**、**件的码怎么定怎么开**、**整条导入管线怎么跑**。
所有规则都是 owner 2026-08-09/10 亲口定的,原话保留在下面,改规则前先看这里。

状态(2026-08-10):**SO 已全部导入并体检通过**;PO 已导 37 张,还缺 61 行(见 §8);照片未进(见 §8)。

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
  (`Leg Change 101Middle Leg(8')` 里的 8' 是脚高)。没写脚 = 用默认(owner:"脚全部找不到就直接选 default")
- **颜色**:`COL:` / `Colour:` / `COL-`,支持分件颜色 `colour (2s): X`;
  `TBC` / `KIV` = 还没选,留空不算错
- **special order**:nylon 底、伞布、`backrest change to 8030`、`fully cover replace the leg`
  等等一律进 specials 跟着行走;**会改结构的**(WOODEN ARM、ARM CHANGE TO SEAT AREA)不自动解,占位等人工

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
| 撤错开的 R/P 件 | `revert-sofa-recliner-skus.mjs` | 同名 yml |
| Bench 改分左右 | `fix-bench-sides.mjs` | 同名 yml |
| 建缺的布料 | `add-missing-sofa-fabrics.mjs` | 同名 yml |
| 补漏拆的旧行 | `repair-leaked-sofa-lines.mjs` | 同名 yml |
| 删已交货误导入 | `remove-delivered-imported-so.mjs` | 同名 yml |
| 成本补盖 | `restamp-imported-so-costs.mjs` | 同名 yml |
| 布料库探针(只读) | `probe-fabric-colours.mjs` | 同名 yml |
| **导入后体检(只读)** | `probe-sofa-import-duplicates.mjs` | 同名 yml |
| 行照片挂载 | `import-so-line-photos.mjs` | 同名 yml |

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

---

## 8. 还没做完的(下一个 session 接手)

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

### 8.4 其他

- 89 行占位(含标记)等人工补件
- 1 张已交货单留着没删(付款是人工录的)
- 620 行的成本没盖上,因为产品本身还没有厂价

---

## 9. 一句话铁律

1. **不确定就不猜**——宁可占位 + 标记,也不要写一个看起来对的件
2. **金额永远不动**——拆件是把一行变多行,总额必须一样
3. **prod 先 dry-run**,数字对得上才 apply
4. **owner 的原话就是规范**,这份文件里的引用不要改写

# 布料码总表 — owner 2026-08-11 亲自给的那一份

**这份文件是「ERP 应该有哪些布料码」的唯一权威。** 在这之前没有这样一份东西:
`scm.fabric_colours` 是一路被单据喂大的 —— 单子上写什么就补什么 —— 所以它既缺码,
又同一个颜色存了好几行。owner 2026-08-11 直接把整份清单发过来,并给了三句话:

> **"这个是我们都应该有的fabric code 你看没有的都帮我开code进去"**
> **"旧的就merge起来 跟我们现在的整齐的"**
> **"同个颜色的就merge起来"**

外加一个拼写裁决(他自己纠正的):

> **"Modenza 才对"** —— 清单里写的 `MONDENZA` 是笔误,**不要**拿它去改 `MODENZA`。

---

## 1. 动手前必须知道的三件事

**(1) 一个颜色可能已经有好几行。** 库里是按**拼法**长的,不是按颜色长的:
`CH141` 14 个颜色占 **28 行**(`CH141-8` 和 `CH141-8-ARMY` 是同一块布)、
`AM275` 14 个占 16 行、`M2402` 12 个占 21 行、`ZL` 和 `ORION` 还有没补零的
`ZL-3` / `ORION-1` 跟补了零的并存。**先不 merge 就直接开 `ZL-03`,只会变成第三种拼法。**

**(2) 什么都不删。** owner 的老规矩是「只取消不删除」,#1972 已经给 fabric merge 定好形状:
输的那一行**留着**,`active = false`,label 上记「被哪个码吸收、什么时候」。
历史单据仍然指得到它,画面上仍然显示得出来。

**(3) 改名字 = 一次只有一个成员的 merge。** 把 `ZL-3` 改成 `ZL-03`,会改掉活跃单据
`variants->>'fabricCode'` 里存的那个字符串。所以**改名也必须把单据一起 repoint**,
一条 arm 都不能漏 —— #1964 抓到的就是漏扫 GRN 那条。

> **arm 是 15 条,不是 4 条**(2026-08-13 从 `backend/scripts/lib/fabric-write.mjs`
> 的 `ARMS` 量出来:SO / PO / GRN / DO / SI / PI / PRT / DRT / CSO / CDO / CDRT /
> PCO / PCR / PCRT / MOV)。这行本来写「四条 arm(SO / PO / GRN / DO)」,那是
> 2026-08-11 当天的实况;`repair-superseded-colour-refs.mjs` 就是去收拾那次
> 「只认得 15 条里的 4 条」留下的活单。除了 `variants` 两个轴之外,同一个码还materialise
> 在 `description2`、库存桶 `variant_key`、和 model 的 `allowed_options` 白名单里,
> 也要一起跟着走。**不要照抄这段清单去手写扫描,`lib/fabric-write.mjs` 才是唯一那份。**

**(4) 这一家脚本可以再跑,但要看得懂 plan。** `normalize-fabric-codes.mjs` 的
CODE / LABEL 那段里,如果 `->` 右边比左边**少了一个词**(`J9226-01 SAND` 变成
`J9226-01`),那就是颜色名字被抹掉,不是整理。2026-08-13 的 prod plan 一次提了
200 条这种,全部 code 没变、只掉名字。原因是名字本来住在 code 里,第一趟把它搬去
label,第二趟再从 code 推就推不出来了。修法是把 label 也当成名字的来源
(`lib/fabric-code.mjs` 的 `nameFromLabel`),现在第二趟是空转。

---

## 2. 清单本体

`ORION` / `TR` / `DE` / `HR805` owner 没给颜色名,那就**只有码,不编名字**。

| 系列 | 码 | 备注 |
|---|---|---|
| **ZL** | `ZL-01` IVORY · `-02` BUTTER CREAM · `-03` CHAMPAGNE · `-04` GREIGE · `-05` SMOKE · `-06` DESSERT · `-07` FOSSIL · `-08` STONE · `-09` TAUPE · `-10` MUSTARD · `-11` ORANGE · `-12` TAN · `-13` OLIVE · `-14` JADE · `-15` MISTY · `-16` METAL · `-17` GREY · `-18` SLATE · `-19` DARK BROWN · `-20` BLACK | ZANO LEATHER |
| **MODENZA** | `-01` HOUSTON CREAM · `-02` BARLEY · `-03` BROWN · `-04` MUSTARD · `-05` DARK OLIVE · `-06` SILVER GREY · `-07` SILVER HEATHER · `-08` GRAPHITE | **不是 MONDENZA** |
| **BO315** | `-01` PEARL · `-02` FEATHER · `-03` BEIGE · `-04` SAND · `-05` FOSSIL · `-06` YELLOW · `-07` PEACH · `-08` SKY · `-09` MINT · `-10` SILVER · `-11` METAL · `-12` DEEP GREY,以及 `-21`~`-32` 是同样十二个颜色**带星号**(`PEARL*` …) | 单子上常写成 `B0315`(数字零),matcher 已经认得 |
| **NX** | `NX001` CANDY · `002` BANANA · `003` HONEY · `004` OPAL · `005` AVOCADO · `006` PACIFIC · `007` LILAC · `008` TORTILLA · `009` EARTH · `010` IVORY · `011` BEIGE · `012` DOVE · `013` GRANITE · `014` SMOKE · `015` FERN · `016` CHARCOAL | 三位数,没有横杠 |
| **GD2502** | `#04` OAK · `#09` SANDY · `#11` WHEAT · `#13` PEARL · `#14` SILVER · `#18` GREY · `#20` DARK GREY · `#22` INK | **label 保留 `#`**(现有行就是这么写的),`colour_id` 统一用横杠 |
| **AM275** | `-01` IVORY · `-02` BEIGE · `-03` LATTE · `-04` WOOD · `-05` BROWN · `-06` BEE · `-07` FOREST · `-08` TURQUOISE · `-09` NAVY · `-10` MAROON · `-11` VIOLET · `-12` SILVER · `-13` GREY · `-14` CHARCOAL | 库里另有一个带空格的假系列 `AM 275` |
| **CH141** | `-01` CREAM · `-02` BEIGE · `-03` KHAKI · `-04` WOOD · `-05` PEARL · `-06` PEACH · `-07` WINE · `-08` ARMY · `-09` SKY · `-10` OCEAN · `-11` SILVER · `-12` METAL · `-13` DEEP GREY · `-14` CHARCOAL | ⚠️ **13 / 14 跟库里是反的**,见下 |
| **M2402** | `-01` PEARL · `-04` SAND · `-05` LIGHT BROWN · `-06` FOSSIL · `-07` DARK BROWN · `-08` YELLOW · `-09` TAN · `-13` FOREST · `-15` AQUA · `-17` SILVER · `-18` LIGHT GREY · `-19` DARK GREY | 号码不连续,是原样 |
| **ORION** | `ORION-01` ~ `ORION-13` | 无颜色名 |
| **TR** | `TR01` ~ `TR21` | **整个系列 ERP 里原本没有** |
| **DE** | `DE01` ~ `DE22` | **整个系列 ERP 里原本没有** |
| **HR805** | `-10` `-20` `-30` `-31` `-40` `-90` | 无颜色名;库里另有一个 `HR805-09`,不在清单上,**不动** |

### ⚠️ CH141 的 13 和 14 是反的

库里今天是 `CH141-13 CHARCOAL` / `CH141-14 DEEP GREY`,owner 的清单是
**`13 DEEP GREY` / `14 CHARCOAL`**。**以 owner 的清单为准。**
动的只有**名字**,码不动 —— 所以已经开出去的单据指的还是同一个码,不受影响。

---

## 2B. 已经跑过什么 (production, company 1)

| 时间 (UTC) | run | 做了什么 |
|---|---|---|
| 2026-08-11 04:18 | `probe-fabric-colours` **31458051902** | 动手前的库存快照:**140 系列 / 742 颜色** |
| 2026-08-11 05:0x | `seed-owner-fabric-catalogue` **31460369953** | **PLAN**:create 88 / merge 39 / rename 34 / 已对 17 |
| 2026-08-11 05:1x | `seed-owner-fabric-catalogue` **31460635442** | **APPLY**:开系列 2(TR、DE)、建 88、superseded 39、改名 70、**活跃单据行 repoint 225**(SO/PO/GRN/DO 四条 arm),VERIFY **PASS**,array-shaped variants **0** |
| 2026-08-11 05:2x | `probe-fabric-colours` **31461158070** | 事后核对:ZL 20/20、MODENZA 8/8、BO315 24/24、GD2502 8/8、TR 21、DE 22、ORION 13 全部到位且带名字 |

**第一次 APPLY 留下的两个尾巴**(核对时发现,不是猜的):`AM275-07` 留在带空格的系列
`AM 275` 底下,`NX016` 留在一个叫 `NX016` 的单颜色垃圾系列底下 —— **颜色对了,系列不对**,
所以在自己系列的 picker 里看不到。改名只动 `colour_id`,不会搬 `fabric_id`,这就是原因。

**`merge-duplicate-fabric-series` 修不了这两个**,已经用 plan 验证过
(run **31461314399**):它按引用数选边,`AM 275` 因为握着那 2 条活跃单据会**赢**,
于是 16 个真颜色会被搬到带空格的名字底下 —— 反了;`NX` 和 `NX016` 则**一个颜色码都不共享**,
它的探测器看不见这一对,log 里自己写了 "Owner decision, not merged here"。

所以本脚本补了 **RE-PARENT**:把颜色搬到它**自己的码所指的系列**,顺手把指着旧系列的活跃行
(`variants->>'fabricId'`)一起 repoint,旧系列如果因此空了就 `active = false` 退休 —— **不删**。

---

## 2C. 第二天的第二半 - Fabric Converter (scm.fabric_trackings)

**Converter 是主表，布料库是它镜像出来的**，不是反过来 (`fabric-tracking.ts:74-82`)。
2026-08-11 上午的正规化改的是镜像那一侧，主表原封不动，于是两边的码劈开了 —— 而
`fabric_code` 正是**价格档位**的 join key。owner 看到画面时的原话：**"两边一定要一样的啊"**。

| 时间 (UTC) | run | 做了什么 |
|---|---|---|
| 08-11 ~10:2x | `align-fabric-trackings` **31478813584** | PLAN，量出**492 条单据行**对不上主表（SO 310 / PO 126 / GRN 54 / DO 2），涉及 76 个码 |
| 08-11 ~10:4x | `repair-split-colour-numbers` **31487319388** | APPLY，还原 6 个被切坏的四位数码（`NOVENA-100` 名字「3」→ `NOVENA-1003` 等），0 条活跃单据受影响 |
| 08-11 ~11:2x | `align-fabric-trackings` **31488481377** | APPLY **失败并整个回滚** —— tier 是 enum，绑成了 text。没写进任何东西 |
| 08-11 ~11:4x | `align-fabric-trackings` **31489281011** | APPLY，**code 改写 386 / series 填 220 / 重复停用 88 / 新建主表行 122**；孤儿行 **492 → 15**；VERIFY PASS |

**收盘时的两个硬指标（verify 会挡）：**
- 一个 code 被超过一行 **active** 持有 = **0** —— 这正是 `loadFabricByCode` 里说的「档位静默掉档」的成因
- 布料库里有、Converter 没有 active 主行的颜色 = **0** —— 两边一一对应

**还开着的：**

| # | 还开着的 | 下一步 |
|---|---|---|
| 1 | **122 个新建的主表行没有价格档位** —— 整个 TR 和 DE 在内 | **owner**：去 Converter 画面设 PRICE_1/2/3。脚本不编价格 |
| 2 | 15 条单据行仍对不上主表（原 492） | 跑一次 plan，第 1 段会逐个列出来 |
| 3 | 32 个 Converter 有、布料库没有的码（`NOVENA-1005`、`GORGE-3001` 这类四位数） | 开单时选不到；要补就往库里镜像 |
| 4 | **SO 上 7 条 `variants` 是阵列形状** | 跟 fabric 无关。08-11 08:1x 之后出现（在那之前两次 apply 都量到 0），另一路改 specials jsonb 留下的，见 `docs/jsonb-double-encoding-coe.md` |

> **给一年后的人：改布料码永远从 Converter 改起。** 只改布料库，画面看起来对了，
> 价格档位却会静默掉到 PRICE_2，而且没有任何东西会报错。

---

## 3. 怎么跑

Actions → **Seed the owner's fabric catalogue** → Run workflow

| | |
|---|---|
| 只看会做什么 | `mode = plan`(默认,**什么都不写**) |
| 真的写 | `mode = apply` + `confirm = I HAVE REVIEWED THE DRY-RUN` |
| 只做一两个系列 | `series = ZL,TR`(逗号分隔,留空 = 全部) |

脚本:`backend/scripts/seed-owner-fabric-catalogue.mjs`。它把每一条清单项分成四种下场,
plan 阶段就逐行印出来:

- **CREATE** —— 库里认不出任何一行,开新的(必要时连系列一起开)
- **MERGE** —— 认出不只一行:**已经是标准码的那一行赢**(它就是 PK,让它赢才不会撞主键),
  其余的把活跃单据 repoint 过去、然后 `active = false` 标上被谁吸收
- **RENAME** —— 只认出一行但拼法/名字不对:改成标准形,**单据一起 repoint**
- **已经对了** —— 不动

另外还会印一段 **「不在 owner 清单上的行」**,例如 `HR805-09`、`BO315-23=LITE-01`。
**这些一律不动** —— owner 没说要删,而且这里从不删东西。要处理请他逐条讲。

### 匹配用的是共用 matcher,不是本地再写一份

`lib/fabric-colour-match.mjs` 是唯一知道「字母 O 折成 0、但**颜色号码一位都不能动**」
的地方(数字守卫,#1976)。之前五个脚本各抄一份、抄到互相打架,#1893 才收回来一份。
**不要在这里再抄第七份。**

### 「这 12 个系列是 owner 定的」也只有一份:`lib/catalogue-series.mjs`

清单本身是**决定**,不是推导出来的结果,所以任何会自己算出 canonical 码或描述的脚本
都必须先问它。2026-08-14 之前只有 `normalize-fabric-codes.mjs` 知道(而且是自己抄了
一份放在档案里),`tidy-fabric-descriptions.mjs` 完全不知道 —— 那天的 prod plan 就把
owner 自己的 249 行(Converter 78、销售库 171)报成
`code is not canonical (would be DE-01) - fix the CODE first`。一行都没改到,但真正
的问题从此埋在 249 行噪音里。

现在:`isCatalogueSeries(parsedSeries)`,问的是**解析后的系列**,所以 `DE01` 跟
`DE-01` 答案一样。`backend/tests/catalogueSeriesOneList.test.mjs` 钉住三件事——两个
推导脚本都要 import;seed 新加的系列必须在清单里(否则下次 normalize 会把它推翻);
除了 seed 和这份 lib,没有第三个档案列满 12 个。

### jsonb 写法有两条,不是一条

**写单一个 key(scalar):`jsonb_set(..., to_jsonb($1::text))`。** 这是这批脚本在用的。

**写一整个 object:`$n::text::jsonb`,那个 `::text` 是关键。** 只写 `$n::jsonb`
没有用 —— postgres.js 已经把参数标成 jsonb 了,再 cast 一次等于没 cast,结果存进去
的是一个 jsonb **字符串**,不是 object。2026-08-13 就是这样把 7 笔 prod 资料写坏的,
而且写坏它的正是当初为了修这个 bug 才写的那支脚本。

把已经序列化好的字符串绑到 jsonb 参数上,是 2026-08-10 一天之内毁掉 variants 栏三次的
那个写法。两次的完整经过见 `docs/jsonb-double-encoding-coe.md`(第二次在
*IT RECURRED* 那一节)。

> 2026-08-14 补:这一节本来只写了 scalar 那半条,并且把它当成「jsonb 的写法」。
> 少掉的那半条正是让同一个 bug 再犯一次的原因。

---

## 相关文件

- `docs/duplicate-fabric-series-merge.md` —— **系列**层的重复合并(#1972),跟这份是两个轴:
  那份合并 `fabric_library`,这份合并 `fabric_colours`
- `docs/jsonb-double-encoding-coe.md` —— jsonb 双重编码的 COE
- `backend/scripts/lib/fabric-colour-match.mjs` —— 唯一的颜色匹配器

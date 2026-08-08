# Supplier Price List 导入 — DRY-RUN 审核

来源:`Supplier Price List .xlsx`(08.05 更新版,1489 个 AutoCount 码)+ 生产库 probe(2026-08-09)。
**还没写入任何东西。** 以下每一节都等你一句话:OK 就执行,有问题就指出来。

## 一眼总览(将要写入的东西)

| 动作 | 数量 | 说明 |
|---|---|---|
| 设 main supplier 旗标 | 1442 | 现在生产库 **0** 条有 main 旗标;按 Excel 的 Main Supplier 列补上 |
| 补 supplier 成本(binding) | 962 | 只填现在为 0 的,已有成本的一条都不动(核对过:已有的与 Excel 零冲突) |
| 补新 binding | 17 | Excel 有 supplier 但系统没绑的 |
| 补产品档 costing(Product & Maintenance) | 1014 | base_price_sen 只填现在为 0 的;含 71 个从 supplier 分页补的缺价 |
| 新建沙发 model | 4 | HOK 5530 / 5536 / 5537 / 5540(当年标了 NEW 但一直没建) |
| 打开沙发 compartment | 297 个(涉及 54 个 model) | 65 个 model 现在只有 ['1S'] |
| 铸造 compartment SKU | 295 | `{model}-{compartment}`,与现有开法一致 |
| 写沙发成本 grid | 297 个 SKU / 1256 格 | seat_height_prices:座深 × 面料档 × cost;现在全系统是 **0** 张 grid |
| 沙发 supplier binding(带 price_matrix) | 446 | 每家 supplier 自己的 compartment 报价存在自己的 binding 上 |

钱的单位:全部 RM×100 存 sen/centi,来源数字 = Excel 各分页现价(含 2026-04 涨价后的)。

## 面料档位映射(请确认)

ERP 沙发 grid 只有三档:PRICE_1(便宜)/ PRICE_2(默认)/ PRICE_3(贵)。各家四档的,第 4 档这次**没导**(见下面 tier 溢出):

| Supplier | PRICE_1 | PRICE_2 | PRICE_3 | 没导的第 4 档 |
|---|---|---|---|---|
| Hookka(单一价) | — | 现价 | — | — |
| Armani / Dorsettloft 官方表 | Fabric B&C | Fabric A | Luxury | **Premium(共 316 格)** |
| THL | Fabric | Acacia | Half Leather | **Full Leather(共 176 格)** |
| Red Sofa | Normal | EasyClean | Acacia | — |
| Todern | C | B | A | — |
| 床架 Fab2/Fab3 | price1_sen=Fab2 | base=主表价 | — | — |

Red Sofa 取的是 **PRICE + TRANSPORT CHARGES** 那组(到货成本);要改用不含运费的那组说一声。

## 需要你拍板的(按重要性)

### 1. 四个 model 两家都想当 main supplier(grid 先押住没写)
- **9028**:AMN-SF9028 SOFA (400-A004) vs DSL-9028 SOFA (400-D004)
- **9058**:AMN-SF9058 SOFA (400-A004) vs DSL-9058 SOFA (400-D004)
- **8038**:DSL-8038 SOFA (400-D004) vs RDS-5526 SOFA (400-R001)
- **5152**:RDS-5152 SOFA (400-R001) vs THL-5152 (400-T002)

这 4 个 model 的产品档 grid(共 50 个 SKU)等你指定谁是 main 才写;两家各自的报价已存去各自 binding,不会丢。

### 2. 两家 supplier 系统里不存在(涉及 5 个 SKU,先跳过)
- `400-O001` — 建议名:MISCELLANEOUS;SKU:Miscellaneous
- `400-Z001` — 建议名:UNKNOWN — owner to name (AERO mattress-protector source);SKU:AERO-MP (K), AERO-MP (Q), AERO-MP (S), AERO-MP (SS)

给我正式名字我就建,或者说改绑别家。

### 3. 一笔 supplier 改绑
- AK-ARISTOI MATT (Q):现在绑 ['400-E004'],Excel 写 **400-D002** → 按 Excel 改(旧绑定保留、不再是 main)。

### 4. 低置信度的 compartment 翻译(这次没导,共 301 行)

主要是 Red Sofa 的 EL/ER/LT/RT 电动件和 THL 的 p/rr/1F/G 缩写。我的猜法(样例):
- THL `R` → 我猜 `1A(R)(LHF)`(model 2376,RM920)
- THL `2rr` → 我猜 `2S(R)`(model 2376,RM1500)
- THL `3rr` → 我猜 `3S(R)`(model 2376,RM1900)
- THL `r(1 arm)` → 我猜 `1A(R)(LHF)`(model 2376,RM780)
- THL `p (1 arm)` → 我猜 `1A(P)(LHF)`(model 5133,RM1320)
- THL `2pp` → 我猜 `2S(P)`(model 5133,RM2580)
- THL `3pp` → 我猜 `3S(P)`(model 5133,RM3100)
- THL `p(1 arm)` → 我猜 `1A(P)(LHF)`(model 5133,RM1380)
- THL `P` → 我猜 `1NA(P)`(model 5150,RM1720)
- THL `p(No Arm)` → 我猜 `1NA(P)`(model 5150,RM1350)
- THL `p(1 ARM)` → 我猜 `1A(P)(LHF)`(model 5152,RM1400)
- RDS `2NA/S` → 我猜 `2NA`(model 5152,RM1625)
- RDS `1EL/C` → 我猜 `1A(P)(LHF)`(model 5152,RM1150)
- RDS `1EL` → 我猜 `1A(P)(LHF)`(model 5152,RM1070)
- RDS `2EL` → 我猜 `2A(P)(LHF)`(model 5152,RM2164)
- RDS `2ER/W.Arm` → 我猜 `2A(P)(RHF)`(model 5527,RM2803)
- RDS `DAYBED` → 我猜 `DAYBED`(model 5527,RM1335)
- RDS `1ER/T` → 我猜 `1A(P)(RHF)`(model 5527,RM2197)

你确认哪些猜对了,我第二批导入。

### 5. Compartment 池要加 4 个新码

`2.5S`, `2S(R)`, `3NA`, `3S(R)`(2.5 座、3 座无扶手、带躺功能的 2/3 座)。维护池是 append-only,加了不影响旧单。

## 导不了的(数据本身的洞,给你清单)

- **366 个 SKU 全工作簿找不到成本**(Excel 主表空、supplier 分页也没有)——多是 DEMO / 停产 / 老规格。清单在 plan-report.json。
- **20 个 SKU Excel 里没写 supplier**:如 PILLOW CASE、THL-SOFA PILLOW、BEDFRAME(通用码)等。
- **4 个 sheet 型号对不上 ERP**:THL 5151(75cm)、THL 7237、THL 1068(配件另有 SKU)等 — 要不要开新 model?
- **5 个绑不了**(ERP 产品不存在):其中 4 个就是这次要新建的 HOK 沙发,建完自动解决;NB-NH 28 (CUSTOMISE) 剩最后一个。
- **套装价 538 行没导**(1+2+3、2+L、R+2+3 之类):ERP 里套装 = 各件之和,卖价侧有 sofa_combo_pricing;这些行留作对账参考。
- **加购件 42 行没导**(power slide、extend arm、升级背靠等):建议进 special_addons,要的话我做第二批。
- **77 行看不懂**(THL 的 1F/G、2.5(2m) 等)——趟你有空帮我解密。

## 保护规则(照旧)

- 只填空,**绝不覆盖任何非零成本/价钱**;selling price(POS 卖价)一个字段都不碰。
- 全部在一个 transaction 里,行数核对不上就整体回滚。
- jsonb 一律 sql.json() 绑定(0226 的教训)。
- APPLY 需要 workflow 手动输入确认短语。

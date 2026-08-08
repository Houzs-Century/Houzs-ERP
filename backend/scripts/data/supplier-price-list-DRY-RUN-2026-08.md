# Supplier Price List 导入 — CHECK LIST(勾完才执行)

来源:Excel(08.05 版)+ 生产库 probe + DRY-RUN 预演(全绿,零覆盖)。**一个字都还没写入。**

---
## A. 主体部分(按已定规则编好,勾这里就执行)

- [ ] **A1 SKU↔Supplier 归位**:补 main supplier 旗标 1442 条(现在全系统 0 条有 main)、补 binding 成本 962 条(只填 0)、新绑 8 条
- [ ] **A2 Product & Maintenance 指导价**:1020 个 SKU 填 base 成本(只填 0,含 71 个从分页反查的)+ 73 个床架 price1(Fab2)
- [ ] **A3 开 compartment**:51 个 model 开 402 个件、铸 400 个 SKU;**每个 SKU 同步建 supplier binding 430 条(带那家报价矩阵)——“supplier 那边也会有吗”:会**
- [ ] **A4 沙发成本**:288 个 SKU 写基准价 1646 格(每件一个价,面料档**不导**,升级钱走 fabric tier addon 那套)

**A5 各家「基准面料」我取的是哪一列(不对就圈出来):**

| Supplier | 基准列 | 备注 |
|---|---|---|
| Hookka | 01.04.2026 现价 | 单一价 |
| Armani / Dorsettloft | Fabric **B&C** | 官方表最低档 |
| Todern | Fabric **B** | |
| THL | **Fabric** | |
| Red Sofa | **EasyClean** | Normal 列大多是空的,所以取 EasyClean;要改 Normal 说一声 |
| 床架 | 主表价(=各 model 惯用列,已逐台校验) | Fab2 进 price1 |

---
## B. 你已点名的(复述,错了纠正)

- [x] HOK 码是同款别名:**5530=9028、5536=9058、5540=8030、5537 旧码弃用**(0 个新 model)
- [x] Main:**9028 = Hookka、9058 = Hookka、8038 = Dorsettloft、5152 = THL**
- [ ] **B1 → 8030 的 main 是谁?** ☐ Dorsettloft ☐ Hookka(5540)—— 勾一个,这 15 个 SKU 的 grid 就放行
- [x] 不加 2.5S / 3NA / 2S(R) / 3S(R);recliner 一件一件拆:两位躺 = 1A(R)+1A(R),三位 = 1A(R)+2A

---
## C. 待你逐条勾的

### C1 拆件确认(3 行 — 原表是整件报价,按你的规则要拆)

| 表上写 | 家 | model | 价 | 我建议拆成 | 勾 |
|---|---|---|---|---|---|
| `3NA` | DSL | 8060 | RM1800 | 1NA + 1NA + 1NA | ☐ |
| `3NA` | DSL | 8060 | RM1920 | 1NA + 1NA + 1NA | ☐ |
| `3NA` | DSL | 8060 | RM2040 | 1NA + 1NA + 1NA | ☐ |

拆开后单件价格表上没有——要么问厂,要么你给拆价规则(对半?)。

### C2 低置信度翻译(299 行没导,样例)

- ☐ THL `R` → 我猜 `1A(R)(LHF)`(model 2376)
- ☐ THL `2rr` → 我猜 `2S(R)`(model 2376)
- ☐ THL `3rr` → 我猜 `3S(R)`(model 2376)
- ☐ THL `r(1 arm)` → 我猜 `1A(R)(LHF)`(model 2376)
- ☐ THL `p (1 arm)` → 我猜 `1A(P)(LHF)`(model 5133)
- ☐ THL `2pp` → 我猜 `2S(P)`(model 5133)
- ☐ THL `3pp` → 我猜 `3S(P)`(model 5133)
- ☐ THL `p(1 arm)` → 我猜 `1A(P)(LHF)`(model 5133)
- ☐ THL `P` → 我猜 `1NA(P)`(model 5150)
- ☐ THL `p(No Arm)` → 我猜 `1NA(P)`(model 5150)
- ☐ THL `p(1 ARM)` → 我猜 `1A(P)(LHF)`(model 5152)
- ☐ RDS `2NA/S` → 我猜 `2NA`(model 5152)
- ☐ RDS `1EL/C` → 我猜 `1A(P)(LHF)`(model 5152)
- ☐ RDS `1EL` → 我猜 `1A(P)(LHF)`(model 5152)
- ☐ RDS `2EL` → 我猜 `2A(P)(LHF)`(model 5152)

全表在 `supplier-price-list-plan-report-2026-08.json` → low_confidence_units。

### C3 一个矛盾:2NA

你说“我们没有 2NA”,但现在 pool 里有 2NA、10 个 model 开着 2NA、Hookka/Armani/Dorsettloft 表上都有 2NA 报价(两位无扶手,和 1NA 同族)。
- ☐ 2NA 保留(我照表导) ☐ 2NA 关掉(告诉我现有的怎么处理)

### C4 同款合并(表上的对照,现在 ERP 是分开的 model)

- ☐ 8030 = RDS-5527?  ☐ 8038 = THL-5150?  ☐ 8039 = RDS-558?  ☐ 8050 = THL-2379?

勾了的我出合并方案(牵涉旧单据,单独评估,不在这一批)。

### C5 两家 supplier 要名字

- ☐ `400-O001`(SKU:Miscellaneous)→ 名字:________
- ☐ `400-Z001`(SKU:AERO-MP (K), AERO-MP (Q), AERO-MP (S), AERO-MP (SS))→ 名字:________

### C6 表上有、ERP 没有的型号

- ☐ THL 5151 (75cm)、THL 7237 —— 开新 model?还是别名?
- ☐ AMN 9025 / 9027 / 9036:官方新表没有,只有旧矩阵(涨价前);按 +10% 推?还是问 Armani 要新价?

### C7 数据洞(参考,不用勾)

- 366 个 SKU 全工作簿无成本(多是 DEMO/停产);20 个无 supplier;217 个新开件表上没价
- 面料升级差价 492 格已留档(A/Luxury/Premium/皮价等);套装 538 行、加购件 38 行、看不懂 77 行 —— 都在 report JSON,第二批处理

---
执行方式:A+B 勾完 → workflow `load-supplier-price-list`(dry-run 已验证)→ apply(确认短语)→ 单事务,不符即回滚。

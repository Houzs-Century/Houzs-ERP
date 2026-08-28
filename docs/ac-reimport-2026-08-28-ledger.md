# AutoCount → ERP 重新导入（第二轮）流水账 — 2026-08-28 开账

> **这本账存在的理由是 owner 的原话（2026-08-28）：**
> 「记得 记录整个过程 可能我们这个也是 testing 然后之后 我们清洗了 再重新弄过。」
>
> 所以每一步都要能照着重走：跑了什么、run id 多少、数字多少、谁拍了什么板。
> 规矩沿用 `docs/autocount-cutover-ledger.md`（8 月第一轮的总账）：
> **历史行不改**，状态变了加新行；每个数字指得出出处；owner 原话原样保留。

## 0. 这一轮和第一轮（2026-08-09~11）的差别 — owner 拍板记录

| # | 拍板 | owner 原话 / 日期 |
|---|---|---|
| 1 | **SO 整张进**：一张单只要还有任何一行没送完，整张全部行都导入（含已送完的行），第一轮是只导没送完的行（245 行已送行缺席、39 张单头金额比 AutoCount 小） | 「如果是进整张，你就需要把它已经送货的 DO 也放进来 … ok」2026-08-27 |
| 2 | **DO 全配**：导入单的所有送货单都建镜像（不只部分送货的），照旧 `migrated_no_stock`、零库存流水 | 同上 |
| 3 | **GR→PI 链完善**：已收货 PO 配迁移 GRN；发票走"金额与 AutoCount 分毫相等才开"的镜像规矩（不重复记账、不动余额、不回推 AutoCount）；这一轮从一开始就带发票价钱，消掉第一轮"我们这边 RM 0"的 222 张拒绝 | 「有了 GR 之后，Purchase Invoice 也是要完善掉的」+「发票照旧走…镜像规矩 ok」2026-08-27 |
| 4 | **先清空再导**：ERP 的 HC 交易+库存清掉、主数据保留、号码继续往上（DOC_COUNTERS=keep，绝不归零） | 「而且你需要把我们目前的数据clear掉」2026-08-28 |
| 5 | **测试单永不回流**：所有导出条件排除 `DocNo LIKE 'HC-%'`（ERP 写回去的）和 `'ZZ%'`（QA 假单） | 本轮新规 |
| 6 | **每行收货量 = 行自己的 `PODTL.TransferedQty`**；聚合的 GrQty 这一轮**根本不导出**（第一轮它制造了 130 行假超收） | 第一轮教训，mig 记录 §9.1 |
| 7 | **新货号**：HOK-1056 六尺寸不开新 SKU，对到现有 `FLAT-(K/Q/S/SS/SK/SP)`；DL-CLASSIC 床褥 6 个、5562 沙发、RC-* 修理费 3 个 = ERP 开新 | 「bedframe我们有flat了 assign sku给hookka 然后放1056」「matress 没问题 sofa没问题 修理费也没问题把？就是我们系统要开进去」2026-08-28 |
| 8 | 冻结（write freeze）**保持全冻**直到导入完成（曾短暂开过"产品与设定"区，owner 说先不解冻，已冻回） | 「那就先不解冻把 我们继续migrate」2026-08-28 |

**待 owner 定（开着，别自己决定）：**
- ① ~~HOK 系列供应商绑定~~ **DECIDED 2026-08-28**：owner 原话「3两个都绑」+「hookka是main」——FLAT×6 和 5562-1S 同时绑 Hookka（400-H004，账本名 HAO HUA FURNITURE）和 OHANA（400-O002，账本 Item 主档的登记），**Hookka 为主供应商**。落地：`backend/scripts/data/ac-newskus-2026-08-28.json` + `align-seed-skus.mjs` 学会读 `is_main`（旧数据档不带 = false，行为不变）+ workflow 加 `data_file` 输入。对照表补 16 行（CSV 行数 1,561→1,577）。
- ② 账本里还 LIVE 的测试单（HC-SO-2608-003~008、HC-PO-2608-002~007、HC-GRN-2608-002~007、HC-DO-2608-004/005/007、HC-PI-2608-002~007、HC-SI-2608-006、ZZDIAG-SO-2）+ 2 个 QA 假货号（ZZ-ERP-QA-ITEM/2）——owner 自己在 AutoCount 清（cancel 或删）。不清也不影响导入（导出已排除）。

## 1. 清空（wipe）— 2026-08-28

| 步骤 | run id | 结果 |
|---|---|---|
| 预演（只数数） | 33143344805 | 会删 **93 行 / 68 张表**（= 8-22~25 的测试残留：SO/DO/PO/GRN/PI/SI 各 2 张 + JE 4 笔 + 明细）；号码计数器 6 个 HC 系列、keep |
| 正式执行 | **33143464728** | **93+4 行删除**（4 行是删除审计触发器回写、sweep 1 轮清掉）；核对全过：HC 交易表全 0、2990 逐表未动、主数据样本未动、出口记录 69 行保留（pending 1 → skipped）、计数器 6 系列原位（下一张 SO = 2608-009）；备份已上传 artifact（90 天） |

## 2. 货号核对（对照表 vs 整理后的账本）— 2026-08-28，只读直连

线路：本机 pyodbc → ZeroTier `10.147.17.100,55500` → `AED_HOUZS`（与第一轮同一条链）。

- 账本 Item 主档：**1,589 个**（active 1,467）；对照表 1,561 个**全部仍在，0 个消失**。
- 新增 28 个 = **16 个真新货**（DL-CLASSIC AURORA REST/DREAM VALLEY 各 3 尺寸、HOK-1056 六尺寸、HOK-5562 SOFA、RC-COM/CUS/TRP）+ **10 个我们自己写回开的沙发件码**（9028-1A(LHF) 等，ensure-masters 的脚印，不需处理）+ **2 个 ZZ QA 假货**。
- 名称是否改过**无法比对**——8-11 的旧快照没存 Description 栏（工具盲点，已如实记录，不当发现）。
- 供应商核实：HOK 前缀 = **OHANA STUDIO 400-O002**（整个 HOK 系列）；400-H004 = HAO HUA FURNITURE；400-D001 = Dunlopillo (M) SDN BHD；RC-* 无供应商（服务项）。

## 3. 新谓词点数（live 账本当场数）— 2026-08-28

| 项 | 第一轮 | 本轮 |
|---|---|---|
| SO（整张规则，剔除直开发票后） | 2,710 张 / 13,588 行 | **2,758 张 / 13,858 行**（含 296 行"已送完"新带入） |
| 直开发票剔除名单 | 129 张 | **2 张** |
| DO 镜像 | 59 张 / 275 行（partial only） | **72 张 / 310 行（全部）** |
| PO lane1（自己没收完，整张） | 157 张 | **188 张 / 429 行**（行数=未收行；整张导出行数见导出记录） |
| PO lane2（为未送 SO 开的，含已收完，整张） | 378 张 | **442 张 / 685 行** |
| 库存有数格子 | 1,020 | **1,075** |

**顺手修正一个仓里的错**：`data/autocount-refetch-po.sql` 写的 `pod.FromDtlKey` 在账本里**不存在**
（该 SQL 写了从未跑过）；实名 `FromSODtlKey`（sys.columns 验证）。导出脚本用实名。

## 4. 导出（export-ac-reimport.py，本轮新脚本）

一支脚本重写全部快照档（整份替换）：SO 整张 / iv-excluded / so-dates / PO 两路整张 /
全部 DO 镜像 / 库存余额 / 两个开账成本源 / GR+PI 参考索引（只限本轮 PO 集）/
PO→SO 行链 / outstanding 尺（ac-outstanding-now）。**不在本脚本**：库存分层
（ac-stock-layers，另一 pass）、照片 manifest、fidelity 真值（跑现成的
export-ac-fidelity-truth.py）、live 尺（export-ac-live.py）。

- 第 1 次跑：SO 档 13,858 行 ✅ 与点数一致；统计行因 Decimal 序列化炸掉 → 修（Decimal→float），重跑。
- 第 2 次跑（重跑全程）：SO 2,756 张/13,858 行（含已送完行 297）✅、iv-excluded 2 ✅、
  so-dates 13,858 ✅、PO lane1 188 张/500 行（整张口径：429 未收行 + 71 已收行）✅、
  PO lane2 442 张/685 行 ✅（**lane2 一段查询 23 分钟**）。跑到 DO 段时 **ZeroTier 断线**
  （08S01 semaphore timeout）→ 脚本加：每条语句断线自动重连重试一次 + `START_AT=<段名>` 断点续跑，
  DO 段从 2,756 个单号字面 IN 清单改成内联谓词（点数时同款几分钟跑完）。
- 第 3 次跑（`START_AT=dos`）：DO 72 张/310 行 ✅；库存余额 2,684 格（非零 1,074）✅；
  UTDStockCost 1,348 行 ✅。两个账本真相：
  ① **`DODTL.FromDocDtlKey` 在账本里整列全空**（310 行 0 个有值）——8 月档案里的 SoDtlKey
    是当时另行重建出来的；**导入端（create-migrated-documents 的 DO 半边）根本不读它**，
    配对走「SO 单号 + ERP 货号」按序消耗 + 沙发整组回退，所以无影响，栏位保留为 null。
  ② ItemUOM 没有 `RecentCost`，真名 **`MostRecentlyCost`** → 导出起别名 RecentCost，
    导入端读键（`RealCost || Cost || RecentCost`）不用改。
- 第 4 次跑（`START_AT=costs`）：**EXIT=0，全套落地。** ac-item-costs 181 行（8 月档 944 行——
  旧档没按"任一成本非零"过滤，这版只留有成本的行，导入端取值顺位不变）；ac-gr-refs **980 行**
  （8 月是全账本 82,451 行；这版**只圈到本轮要导的 ~600 张 PO**——盖号脚本只盖导入的 PO，够用且快）；
  ac-po-fromsodtlkey 685 行；ruler（ac-outstanding-now）SO 2,756 / PO 188 / SO-linked 442。

**快照总表（2026-08-28 版，整份替换 8 月档）：**

| 档案 | 行数 | 备注 |
|---|---|---|
| ac-outstanding-so | 13,858 行 / 2,756 张 | 整张口径，含 297 行已送完 |
| ac-so-iv-excluded | 2 | 直开发票剔除名单 |
| ac-so-dates | 13,858 | PDate + 行交期 |
| ac-outstanding-po | 500 行 / 188 张 | 整张（429 未收 + 71 已收行） |
| ac-so-linked-pos | 685 行 / 442 张 | 整张，含已全收；每行 TransferedQty，无 GrQty |
| ac-partial-dos | 310 行 / 72 张 | 本轮起 = 导入单的**全部** DO |
| ac-stock-balance | 2,684 格（非零 1,074） | vItemBalQty 全量 |
| ac-utd-stock-cost / ac-item-costs | 1,348 / 181 | 开账成本一、二顺位 |
| ac-gr-refs | 980 | 收货/发票索引，只圈本轮 PO |
| ac-po-fromsodtlkey | 685 | PO→SO 行链 |
| ac-reimport-manifest.json | — | 各档行数 + 口径说明 |

## 4b. 开货（新 SKU）执行记录

- PR #2747 合并（快照 + 种子档 + 流水账进 main）。
- 开货 dry-run 第 1 次（run 33152112108）：报 `create 3 / skip 17` —— **与只读导出（run 33152256221）矛盾**：
  live 绑定里 20 条一条都不存在（FLAT 只有 NB 六条，5562/DL 全无）。查明：种子档绑定键写了旧名
  `material_code`，现行脚本读 `item_code`（batch-3 命名统一后改的）——每家供应商首行占空键、
  其余 17 行被误判重复；apply 会插 3 条空货号垃圾。**dry-run + 对账拦住了**（docs/bugs/0554）。
- 修正：键名改 `item_code`（fix/ac-newskus-item-code）。
- **发现现成机制**：`mirror-hookka-bindings`（8-25 建）= 把 OHANA 每条绑定镜像到两家 Hookka
  （H003 制造 + H004 实业）并把主供应商统一提到 H004 —— owner 8-09 的老规矩（"两家一样 SKU
  一样价钱；Hookka Industries 有的都是 main"）。**开货 apply 之后跑一次它**：H003 自动补齐、
  FLAT 上 NB 的 main 让位给 Hookka（避免双 main）。

## 4c. 沙发轮 dry-run + 解析器学新写法（2026-08-28 下午）

- 非沙发 SO **全量导入完成**：limit=5 试插（5 单/18 行/5 款）→ 全量 run 33154299948：
  **2,287 单 / 12,934 行 / 2,205 笔付款**，81 条例外全部=源头颜色写残/未选（老类别，行照进颜色留空）。
  直开发票剔除 = 空操作（run 33154425027：名单 2 张、ERP 里 0 张——导出端已排除，双保险一致）。
- 沙发 dry-run（run 33154428381）：469 张全进，**432 组自动拆 / 121 组占位**。占位构成：
  3 行缺件 SKU（00913-3S ×2、8050-STOOL ×1）+ 45 行源头无结构 + 其余为**新写法被保守闸门拦下**。
  按 owner 规则（没 processing date 的缺 variant 没关系）：121 中只有 **32 行在已处理单上**是真工作量。
- **发现：店里 8 月中起换了 Desc2 写法**（SO-0131xx 起）：ERP 词汇 `1A(LHF)+C+2A(RHF)`、
  裸端链 `2A+1A(30')`、颜色在前无 COL: 标签。8 月语料没有这批写法，词表没有 A 系件词。
- 修（feat/sofa-parser-colour-first）：① 词表学 A 系（A+边→既有 E 记法；裸 A 按 owner 草图规则
  两端定边，**行中裸 A 仍然拦**）；② `1B` 词表本来就有（"owner: 1B 我们有"），不必问；
  ③ 颜色维持 #1998 契约——色库确认才收（试过"按位置照抄"，被钉契约的测试拒绝，**撤回**）；
  ④ 真正的洞：**三个导入脚本从来没把色库确认口子传给解析器**（docs/bugs/0555），补上（4 个调用点）；
  ⑤ owner 拍板开 2 个件 SKU（00913-3S、8050-STOOL），加进种子档（products 10→12）。
  10 条真实新行探针从"全拦"→ 9 high + 1 medium 全拆对；141 测试绿；light 全套除 3 个已知
  本机 CRLF 假红（CI Linux 同套绿）外全过。

## 5. 待办队列（照第一轮 19 步序，按本轮口径改）

导出全部落地并核对 → 对照表补 16 行 + 开新 SKU（等 owner 定 ①）→ 导入 SO（non-sofa → sofa）→
删 IV 名单（2 张）→ PO lane1 → lane2 → topup → 库存余额 → 分层 → 沙发库存 → GR/PI 号 stamp →
行键 backfill ×2 → PO 行键 → dedication → 纯损失修复 → 文本链 → ac_item_code seed →
迁移 GRN/DO 建档 → 迁移发票（金额相等规则）→ allocation 重算 → 验证五连。
每步 dry-run 先行、看 notice 不看徽章、APPLY 后独立重读核对——三条全是第一轮的铁律。

## 4d. PO 两路执行（2026-08-28 下午）

- **第一路（自己没收完）APPLY 完成**：run 33157041761 前段 + 重读确认——187 张 / 559 行进 ERP，
  例外 4 条照实（PO-009979 无码枕套行人工补；3 条 taroni 色词照旧留空）。
- **第二路 dry-run**：293 张新建（442−149 与第一路重叠）/ 511 行 / 连回 SO 497 行 / 带收货量 591。
- **第二路 apply（run 33169457109）中途崩**：PO-009555 的供应商 400-R002（RENNES BEDDING）在 ERP
  没有对应行，脚本只数数不跳单，空供应商撞非空约束整跑中断（docs/bugs/0557）。护栏补上（缺主档=
  跳该单点名报告，与第一路一致）。**身份问题挂 owner**：账本 400-R001 现名 RED SOFA PLT（23 个 RDS
  货的主供应商都登它），ERP 的 400-R001 却叫 RENNESS BEDDING，账本另有 400-R002 RENNES BEDDING——
  一家改名还是两家错码，owner 定；导入只照抄账本补 400-R002 一行，不判合并。
- **owner 裁定（「应该不一样啊」）**：RED SOFA 和 RENNES 是两家公司——ERP 400-R001 那行是
  **贴错名**（号对、名错）。修法 = 改名为 RED SOFA PLT（号与绑定不动；本批有 2 张 RED SOFA 的
  PO-000425/001068 会因此显示正确），工具 repair-supplier-names（plan 默认 + 确认句 + 独立复核）。
## 4e. 日期两个框不亮 — owner 在 HC-SO-013097 上抓到的（2026-08-28）

账本明明有（UDF_PDate 2026-08-17、行交期 2026-09-24），画面两个日期空。查实：
① 导入把 processing date 写进了 **8-18 就退役的旧栏 proceeded_at**（0286 改名后画面只读
`processing_date`，导入脚本没跟着搬家）；② 送货日期本来就属于补日期那一步，本轮还没跑，
而补日期脚本写的也是旧栏。两个脚本一起搬正（docs/bugs/0556），防呆名单保留旧名匹配。
账本里该亮的：processing 538 张、delivery 545 张（2,756 张里）——补日期 apply 后逐一核对。
另：PO-009979 的无码行「ERGOTEX PILLOW CASE - FAIR ×20 @RM50」照实例外，导入后人工补一行。

## 4f. 下午执行流水（2026-08-28，日期補跑 → 库存 → 行键）

跑一步、核一步，全部走 workflow_dispatch，run 号附在每条后面：

- **补日期 apply**：单头 551/551 张补上（processing / delivery 两个日期），行交期 2,528/2,528 行，
  人手改过的单 0 张被拒（本轮全是刚导入的，没人碰过）。owner 在 HC-SO-013097 抓到的两个空框，
  这一步之后亮了。（run 33170449326）
- **库存余额 apply**：981 格 / +9,699 件写入（其中 837 格暂零成本，等分层那步补成本）。
  独立复核 = 重跑一次 dry-run：**剩 0 格 / +0 件**，即账本余额已全部搬平。差成负数的 153 格
  （多是 DISPOSE 报废仓）只报告不写——ERP 不记负库存，属预期。5 个货号没绑定（枕套例外那批）。
  （apply run 33173101230，复核 run 33174030232）
- **沙发库存 apply**：116 批 / 116 件开仓批次写入，成本按账本批次成本。allocation 重算之后
  沙发行才会亮绿——这是设计，不是漏。（run 33173822826）
- **GR/PI 号 stamp**：316 张已收货 PO 盖上账本的收货单号+采购发票号（只写参考号，不建收货、
  不动库存——收货镜像是后面「迁移建档」那步的事）。（run 33174196073）
- **行键 backfill（沙发）apply**：782/782 行连回账本行；47 行账本找不到对应行、39 行数量对不上
  ——照规矩不猜，留名单。PO 侧 0 行（沙发 PO 行第一路已带键进来）。（run 33175468166）
- **行键 backfill（普通）apply**：~13,400 行，跑的时候本节在写，结果另起一条补记。（run 33174466591）

**一个假警报，记下来免得下轮有人上当**：诊断工具「PO 收货核对」在这个时点必然报红
（HC-PO-* 显示已收货、ERP 里却没有收货记录），因为收货镜像还没建——它建议重放旧的重算迁移，
**千万别跑**，跑了会把账本抄来的已收数量清零。等迁移建档跑完它自然转绿。（run 33174815264）

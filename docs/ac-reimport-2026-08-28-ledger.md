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

## 5. 待办队列（照第一轮 19 步序，按本轮口径改）

导出全部落地并核对 → 对照表补 16 行 + 开新 SKU（等 owner 定 ①）→ 导入 SO（non-sofa → sofa）→
删 IV 名单（2 张）→ PO lane1 → lane2 → topup → 库存余额 → 分层 → 沙发库存 → GR/PI 号 stamp →
行键 backfill ×2 → PO 行键 → dedication → 纯损失修复 → 文本链 → ac_item_code seed →
迁移 GRN/DO 建档 → 迁移发票（金额相等规则）→ allocation 重算 → 验证五连。
每步 dry-run 先行、看 notice 不看徽章、APPLY 后独立重读核对——三条全是第一轮的铁律。

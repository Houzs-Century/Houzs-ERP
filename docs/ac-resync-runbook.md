# AutoCount → ERP 重同步手册(RUNBOOK)

> 目的:账本安静后,把 AutoCount 期间的全部变化**更新式**同步进 ERP,并验证到
> 三个 0(库存 0 差、字段 0 差、状态真嫌疑 0)。首次全程见
> `docs/ac-reimport-2026-08-28-ledger.md` §4j–4l;本手册是它的可执行蒸馏。
> 预计时长:1–2 小时(首轮 12 小时的教训已全部内化:行键/日期/状态出生自带、
> 快照只认内部日期、生成物跟着快照重生成、确认句裸调、卡队先查自己单)。
>
> 铁律:每一步 dry/plan 先行 → 读 notice 数字 → apply → 独立复读;**绝不删数据**;
> 人碰过的行一律拒改;不猜——配不上的照实列名单。

## 阶段 0 — 前置(本机,~15 分钟)

1. 确认账本安静(owner 宣布 / lock)。
2. 新 worktree 或干净分支 off origin/main;`npm ci`。
3. **全量重导出**(ZeroTier 直连,凭据文件路径见下;断线可 `START_AT=<节>` 续,
   单节补拉用 `ONLY=<节>`,绝不覆盖别节):
   ```bash
   AC_CRED_FILE=<scratchpad>/.ac-cred python backend/scripts/export-ac-reimport.py
   AC_CRED_FILE=... python backend/scripts/export-ac-invoice-refs.py
   AC_CRED_FILE=... python backend/scripts/export-ac-invoice-prices.py
   ```
4. **快照落地前的三件套**(首轮各吃过一次亏,缺一 CI 必红):
   ```bash
   npm --prefix backend run gen:ac-sofa-corpus
   npm --prefix backend run gen:ac-item-map
   npm --prefix backend run test:light   # 数据钉死测试红了就按合同重钉+注日期
   ```
5. 一个 PR 提交:全部 `data/*.gz` + manifest + 两个生成物 + 重钉的测试 → 进队。
   (对照表若有新码:先补行——货号 30 字截断的照原样、ERP 名跟家族惯例;
   新码同时准备 `ac-newskus-<date>.json` 种子档。)

## 阶段 1 — 单据(全部幂等:有的跳过、新的进、apply 后看「跳过/新增」两个数)

按序 dispatch(每个:无 apply 参数=dry → 读数 → `apply=1` 重发;带确认句的**裸调**,
不要包在 shell 函数里——引号会哑):

| # | workflow | 备注 |
|---|---|---|
| 1 | `import-ac-outstanding-so.yml` | **两趟**:先默认(非沙发)再 `sofa=yes`;新单出生自带日期/Remark2-4/note/行键 |
| 2 | `import-ac-outstanding-po.yml` | 一路(未收满整张) |
| 3 | `import-ac-so-linked-pos.yml` | 二路(为在册 SO 开的,含已收满;行对行绑定) |
| 4 | `topup-ac-po-lines.yml` | apply 要 `confirm="I HAVE REVIEWED THE DRY-RUN"` |
| 5 | `stamp-ac-grn-refs.yml` | 盖收货/采购发票号 |
| 6 | `create-migrated-documents.yml` | `kind=both`;GRN+DO 镜像,**不动库存** |
| 7 | `create-migrated-invoices.yml` | `mode=apply` + 同上确认句;金额一分不差才开,DIFFERS 名单呈 owner |

## 阶段 2 — 库存(双向对平)

| # | workflow | 备注 |
|---|---|---|
| 8 | `import-ac-stock-balance.yml` | **`neg=1`**;dry 时正负两列都过目(负=期间送掉的,按 FIFO 扣) |
| 9 | `import-ac-sofa-stock.yml` | 沙发批次补入 |
| 10 | (如价目表>2天旧)`stamp-real-po-costs.yml` | 先本地重跑 export-ac-invoice-prices.py 并入阶段0的PR;apply 带确认句 |

## 阶段 3 — 改值刷新(账本期间被改的)

| # | workflow | 备注 |
|---|---|---|
| 11 | `refresh-so-tail-from-book.yml` | apply 要 `confirm="REFRESH SO TAIL"`;头 7 字段+行交期,改值照账本、清空照清、人碰过的拒 |
| 12 | `backfill-ac-line-keys.yml` + `backfill-ac-sofa-line-keys.yml` | plan 应报 to-set≈0(出生自带);>0 才 apply |

## 阶段 4 — 重算与终验(全绿才算完)

| # | workflow | 通过标准 |
|---|---|---|
| 13 | `enqueue-so-allocation-recompute.yml` | apply+确认句;**等 ~10 分钟** Worker 班车吃单(plan 复读:队列行消失、READY 数变动) |
| 14 | `import-ac-stock-balance.yml`(dry, neg=1) | **归零证明:正 0 / 负 0** |
| 15 | `check-so-dates-truth.yml` | 八字段 **DIFFER 全 0** |
| 16 | `check-ac-vs-erp-reconcile.yml` | 「收满必亮」= **0** |
| 17 | `check-remark2-vs-status.yml` | **ALGO-SUSPECT = 0**;其余差异四抽屉归因即合格(已送过时/没自家PO/粒度/需求>库存) |

## 阶段 5 — 上线封关(最后一轮才做)

1. Owner 在 AutoCount lock/封权限。
2. 跑一遍阶段 0–4(此时增量极小,~1 小时内)。
3. **开回写总开关**(`scm.autocount_writeback`,owner 指令才开)。
4. **回写烟测矩阵**(一张 import 的旧单走全程,逐项在 AutoCount 里目验落点):
   改 processing/delivery date → proceed → convert PO → GR 收货 → DO 出货 →
   SI 开票 → 每步等一班(≤5 分钟)后开账本看**同一张单的同一行**被更新。
   已在真账本验证过:六种单据+取消;**尚未走完全程的两个动作 = 改单回写、
   ERP 开新 PO 回写**——烟测重点盯这两个。
5. 烟测全绿 → AutoCount 只读,ERP 唯一编辑面。此后账本继续可当对照数据库
   (回写班车 ≤5 分钟一班,不是秒级;对账时留这个时间差)。

## 常见红灯处置(首轮实测)

- CI 红在 `audit:ac-sofa-corpus` / `audit:ac-item-map` → 忘了阶段0第4步,重生成。
- 数据钉死测试红 → 照测试文件里的合同重钉+日期注释(不许改合同本身)。
- 队列 BEHIND >40 分钟 → 本地 `git merge origin/main` 推回;先查**自己单**的必需
  检查有没有红(「已挂自动合并」≠「在队里」)。
- 带确认句的 apply 显示 CONFIRM 空 → 裸调,别过 shell 包装。
- 快照文件 mtime 是今天 ≠ 内容是今天:**只认文件内部的 exportedAt/generatedAt**。

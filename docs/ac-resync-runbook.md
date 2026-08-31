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
不要包在 shell 函数里——引号会哑)。

⚠️ **每次 dispatch 都带 `-f target=prod`**(收 target 的 workflow 默认全是
staging——2026-08-30 一趟 SO apply 就这样整批落进 staging,job 名 `run-staging`
才暴露;prod 未动,但白等一轮。验法:读 run 日志第一行 `Complete job name:
run-prod`)。少数 workflow 不收 target(如 `refresh-so-tail-from-book.yml`、
`rename-new-code-rows.yml`,天生 prod)——422 Unexpected inputs 就去掉该参数重发。

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

## 阶段 3b — 照片(账本里的行照片 → R2 → 挂回 ERP 行)

四步一条线:**导出 → 上传 → 挂回 → 验**。前两步只能在这台机器跑(账本走
ZeroTier,只有这里连得到);后两步是已有的 workflow。

> **为什么这轮要新写导出器**:第一轮(2026-08-09~12)的提取脚本**没留下来**
> (`docs/autocount-further-description-photos.md` §2.1),照片再也拿不出来。
> `backend/scripts/export-ac-line-photos.py` 就是补回来的那一半。
>
> 账本实测(2026-08-31,只读):**SO 2,723 行、PO 2,392 行**带照片,**全部是
> `\wmetafile8`**(jpegblip/pngblip/emfblip/dibitmap 都是 0)。第一轮的 manifest
> 只有 554 SO + 190 PO 张,而且是从 DtlKey 34553 才开始数的——**账本里绝大部分
> 老单的照片从来没被拿出来过**。

### 1. 导出(本机,只读账本)

```bash
AC_CRED_FILE=<scratchpad>/.ac-cred python backend/scripts/export-ac-line-photos.py
```

断线可直接重跑:它按 DtlKey 记断点(`<OUT_DIR>/<so|po>/.state.json`),**已经
拿过的行不会再下载一次**——下载才是慢的那头(单行 RTF 实测有 458,878 字节)。
先试小样:`SIDE=so LIMIT=20 ...`。

成功长这样(每 100 行报一次进度)。⚠️ **下面这段是「长什么样」的示意,不是跑完的
纪录**:到 2026-08-31 为止只**实跑过 20 行的小样**(SO,`LIMIT=20`,20 张全成、
全走 dib、0 失败),整本 5,115 行**还没跑过**,PO 侧一行都还没跑过。整本的真实数字
要以跑完那次的输出为准。

```
self-test: DIB scanner OK (2x2 metafile -> 355-byte JPEG via dib)
== SO ==  already extracted: 0 image(s); resuming after DtlKey 0
  ... 100 lines read, 100 images written (DtlKey 152114)
  lines read this run: 2723; images written this run: 2723
  picture forms: wmetafile8=2723
  conversion:    dib=2723
  manifest: .../ac-photo-manifest.json.gz (2723 image rows, ...)
EXPORT DONE. SO: 2723 new image(s), 2723 in manifest, 0 failed line(s)
```

三个要看的数:`failed line(s)` **必须 0**;`conversion` 里出现 **`gdi-render`**
就要警觉——那几张是我们自己画出来的像素、不是账本存的,先看图再决定上不上传;
第一行的 `self-test` 没出现就说明解析器根本没跑起来,**别把 0 张当成"账本没照片"**。

### 2. 上传 R2(本机;需要 owner 放好的 token 档)

Token 由 owner 在 Cloudflare 后台开(R2 → API → Create API token,对 `houzs-erp`
桶给 **Object Read & Write**),存成 `C:\Users\User\Desktop\.r2-token.txt`。
**脚本只把它塞进子进程环境,从不打印**;账号必须是公司账号
`816e457307d7fa0491c2a08a72ad5dcd`(本机 wrangler 登的是个人账号,没有 r2 权限,
直接 403)。

先把「文件 → key」的对照表跑出来(第 3 步的 workflow 默认就是这个 RESOLVE 模式,
把 run log 存下来即可),再:

```bash
# 一)先看计划,什么都不传
PLAN=so-resolve.log PHOTO_DIR=<OUT_DIR>/so node backend/scripts/upload-line-photos-r2.mjs
# 二)确认无误才传
PLAN=so-resolve.log PHOTO_DIR=<OUT_DIR>/so MODE=apply \
  CONFIRM="I HAVE REVIEWED THE PLAN" node backend/scripts/upload-line-photos-r2.mjs
# 三)另起一次,重新抽样下载回来核对
PLAN=so-resolve.log PHOTO_DIR=<OUT_DIR>/so MODE=verify node backend/scripts/upload-line-photos-r2.mjs
```

key **不是这个脚本算的**——它只认第 3 步那两个脚本印出来的
`UPLOAD <文件> -> <key>`,并且逐条对照第一轮的格式
(`<so|po>-items/<单号>/<行 id>/ac-<DtlKey>-<n>.jpg`),**对不上就整个拒绝**,
绝不猜一个前缀传上去。传成功的 key 逐条写进 `<PHOTO_DIR>/.uploaded.txt`,
中途杀掉再跑会跳过它们(PO 侧同理,`PHOTO_DIR=<OUT_DIR>/po`)。

成功长这样。⚠️ **同上,这是示意的形状,不是跑过的纪录**:到 2026-08-31 为止
**一次 R2 上传都没做过**(token 档还没建),只验过 plan 模式和四道闸门会拒
(错格式 key / 无确认句 / 错确认句 / 没 token 档,四个都实测 exit 2)。

```
APPLIED. uploaded: 2723; already in R2: 0; failed: 0
VERIFY: re-reading 20 of 2723 uploaded key(s) from R2 on fresh processes
VERIFY: 20 byte-identical to the manifest; 0 present but unverifiable; 0 missing; 0 wrong
VERDICT: PASSED. Attach with import-so-line-photos.mjs / import-po-line-photos.mjs APPLY=1.
```

`VERDICT: PASSED` 之前**不要挂回**——验的是 **sha256 对得上**,不是"文件在不在":
空档和被截断的档都"在"。

### 3. 挂回 ERP 行(workflow,和第一轮同一套)

| # | workflow | 备注 |
|---|---|---|
| 12b | `import-so-line-photos.yml` | 先默认(resolve,只印计划)→ 读数 → `apply=1`;**每次都带 `-f target=prod`** |
| 12c | `import-po-line-photos.yml` | 同上 |

resolve 那趟的 log 就是第 2 步要的 `PLAN` 档,顺序上是:**先 resolve 拿 key →
上传 → 再 apply 挂回**。挂回是幂等的(已经在 `photo_urls` 里的 key 会跳过)。

### 4. 验

resolve 再跑一趟,`already attached` 应该等于上一趟的 `photo keys planned`;
`unmapped` / `order-not-imported` / `line-missing` 三个数就是挂不上的名单,
**照实列出来给 owner**,不要吞。

> ⚠️ **账本里有一行挂两张以上照片**(2026-08-31 实测:SO 最多 2 张,PO 最多 5 张)。
> 导出器按 `_1`/`_2` 全部拿,不会只取第一张;但**回写**(ERP → AutoCount)那条路
> 是整个 `FurtherDescription` 字段覆盖式重写,所以在回写这类行之前必须先读回账本
> 现有的值,否则第二张会被**抹掉**。详见
> `docs/autocount-further-description-photos.md` §7 问题 8。

## 阶段 4 — 重算与终验(全绿才算完)

| # | workflow | 通过标准 |
|---|---|---|
| 13 | `enqueue-so-allocation-recompute.yml` | apply+确认句;**等 ~10 分钟** Worker 班车吃单(plan 复读:队列行消失、READY 数变动) |
| 14 | `import-ac-stock-balance.yml`(dry, neg=1) | **归零证明:正 0 / 负 0** |
| 15 | `check-so-dates-truth.yml` | 八字段 **DIFFER 全 0** |
| 16 | `check-ac-vs-erp-reconcile.yml` | 「收满必亮」= **0** |
| 17 | `check-remark2-vs-status.yml` | **ALGO-SUSPECT = 0**;其余差异四抽屉归因即合格(已送过时/没自家PO/粒度/需求>库存) |
| 18 | `check-ac-erp-doc-links.yml` | 两边关系图互查(SO/PO/DO/GR/PI 在册、SO→PO 行级绑定、DO 认对父单、账本已开票而 ERP 还活着的单)——**backlog = 0** 才算两图一致;非 0 的每一项就是下一轮的补课名单(owner 2026-08-30:不要只看一张 SO,要各单互相验证)。快照 >2 天旧会自拒,先跑阶段 0 |

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

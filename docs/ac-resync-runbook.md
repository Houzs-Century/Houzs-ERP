# AutoCount → ERP 重同步手册(RUNBOOK)

> 目的:账本安静后,把 AutoCount 期间的全部变化**更新式**同步进 ERP,并验证到
> 三个 0(库存 0 差、字段 0 差、状态真嫌疑 0)。首次全程见
> `docs/ac-reimport-2026-08-28-ledger.md` §4j–4l;本手册是它的可执行蒸馏。
> 预计时长:1–2 小时(首轮 12 小时的教训已全部内化:行键/日期/状态出生自带、
> 快照只认内部日期、生成物跟着快照重生成、确认句裸调、卡队先查自己单)。
>
> 铁律:每一步 dry/plan 先行 → 读 notice 数字 → apply → 独立复读;**绝不删数据**;
> 人碰过的行一律拒改;不猜——配不上的照实列名单。
>
> **本档是「怎么跑」。「每支导入器读什么、写不写生产、跑第二次会怎样、人要准备
> 什么、哪一步不可逆」在 `docs/autocount-remigration-runbook.md`** —— 两边打架时
> 以本档为准(它是流程),另一边写错就开 PR 改。

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
| 2 | `import-ac-outstanding-po.yml` | 一路(未收满整张)。**exit 2 + `REFUSED …not in the catalog` 不是坏掉**——见下 |
| 3 | `import-ac-so-linked-pos.yml` | 二路(为在册 SO 开的,含已收满;行对行绑定)。同上 |
| 4 | `topup-ac-po-lines.yml` | apply 要 `confirm="I HAVE REVIEWED THE DRY-RUN"` |
| 5 | `stamp-ac-grn-refs.yml` | 盖收货/采购发票号 |
| 6 | `create-migrated-documents.yml` | `kind=both`;GRN+DO 镜像,**不动库存** |
| 7 | `create-migrated-invoices.yml` | `mode=apply` + 同上确认句;金额一分不差才开,DIFFERS 名单呈 owner |

⚠️ **两路 PO 导入现在会「拒绝写不存在的件号」**(2026-08-31,
`docs/bugs/0577-a-purchase-order-carried-an-internal-sofa-code-no-product-ro.md`)。
从前对照表指到一个产品清单里没有的件号时,它会**默默照写**——`5540-1S` 就是这样进了
31 行单据,那张采购单因此接不回它自己的销售单。现在遇到这种行,它会把每一行连单号
一起列出来,然后 **exit 2,一行都不写**。

看到这个不要重试,先看它列的是什么:
`backend/scripts/data/autocount-erp-mapping-1561.csv` 里把那个账本件号指到一个**真的
存在**的 ERP 件号(或先把产品开出来),再重跑。旧单据的修补是另一支:
`repair-orphan-sofa-codes.yml`,先 `mode=plan` 看清单。

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

#### ⚠️ 断点看不到「旧行后来才加的照片」——补跑必须先做一次普查(bug 0655)

断点是 `DtlKey > last`,而 DtlKey 是**行**的身份、不是**照片**的身份。同事在一张
早就存在的单上补一张照片,那一行的 DtlKey 还是旧的小号码,**断点永远走不到它**,
补跑会印 `new: 0` 而你会信。2026-09-07 实测:账本比 2026-08-31 的 manifest 多出
**SO 38 行、PO 17 行**带照片,其中四行(DtlKey 802568 / 824817 / 858533 /
873097)远在断点 917,140 **之下**。

`FORCE=1` 能找到,但**上线当天不许用**:它会把整本的 `FurtherDescription` LOB
重新拉一遍,而那条 SQL 实例正是 ERP 写回 AutoCount 用的同一台。当天早上就是因为
有人对这个栏位跑了不设边界的扫描,写回直接
`SalesOrder.InternalSave()` → `The wait operation timed out`;把扫描停掉之后同一个
写入测试 40/43 通过。

所以补跑的正确顺序是**先只读普查、再定点提取**:

1. **普查**(只读,不取照片位元组)。每批都带明确范围
   `WHERE DtlKey > @last AND DtlKey <= @last + @w`,只选 DocNo、DtlKey 和
   `{\pict` 的**出现次数**,逐批写到本机档案;每批 15 秒超时,超时就把批调小,
   不要干等。每十批查一次
   `sys.dm_exec_requests`(`blocking_session_id <> 0`)确认自己没挡住写回。
2. 把普查结果和 manifest 对一下,列出**缺的 DtlKey**。
3. **定点提取**——比平常那条查询**更窄**,所以上线当天跑是安全的:

```bash
AC_CRED_FILE=<path> DTLKEY_FILE=<缺的key清单> BATCH=10 \
  python backend/scripts/export-ac-line-photos.py
```

清单一行一个 key,`so 802568` / `po 914481` 这种写法可以一个档同时喂两边。这个模式
**不会动 `.state.json`**(它是故意去读断点以下的 key 的),而且某一边一个 key 都
没有时会明讲,不会印 `new: 0` 装作账本很干净。

2026-09-07 实跑:SO 读 38 行、PO 读 20 行,写出 **38 + 22 张、0 失败**(PO 张数比
行数多,就是一行多张的情形)。

#### 一行不只一张照片——PO 侧尤其明显

**别写「一行一张」的逻辑**。2026-09-07 普查账本:PO **2,409 行里有 152 行不只一张**
,最多一行 **5 张**;SO 只有 1 行 2 张。导出器用 `__<DtlKey>_<n>.jpg` 编号,挂回
脚本用 `ac-<DtlKey>-<n>.jpg` 编号,两边都已经支援;当成一行一张会**静静漏掉 152 行**。

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

> **`.uploaded.txt` 只是「快」,不是「对」——重抽过的照片一定要清掉它再传。**
> 脚本自己的注释就写着这一条,2026-09-07 它真的咬人了:`MODE=verify` 抽 30 张,
> 抓到 `so-items/HC-SO-011633/…/ac-802567-1.jpg` 的 **R2 位元组和 manifest 对不上**
> (`f5adb903…` vs `2e0eb8fb…`)。原因不是传错档,是这个 key 在名单里 → 被跳过 →
> R2 留着**上一次提取**的那份位元组,而本机档案后来变了。
>
> 所以**重新提取过之后**,别只补差额:把 `.uploaded.txt` 移开,照整份计划全传一次。
> 同 key 同档覆盖是幂等的,代价只是时间(实测约 1.7 秒一张)。
> `MODE=verify` 是唯一会**真的把位元组抓回来比对 sha256** 的一步 —— 挂回之前一定要跑,
> 它 `VERDICT: FAILED` 就不要挂。

> **更正 2026-09-02。** 这一段原本写着「到 2026-08-31 为止**一次 R2 上传都没做过**
> (token 档还没建)」,并把下面那个方块标成「示意的形状,不是跑过的纪录」。
> **两句都是错的,而且这份文件从没被回来改过。** 上传在 2026-08-31 04:16-04:58 UTC
> 跑完了,就在两趟挂回(04:44 / 05:05 UTC)之前 —— 顺序完全照这份手册。owner 的
> token 档建立于 2026-08-31 10:28(本机时间),路径就是脚本预设的那个。
>
> 代价不是抽象的:2026-09-02 owner 问「照片都进来了吗」,这两句话让答复变成
> 「有 207 行的图可能显示不出来,要你去开一张单看」—— **一个不存在的问题,一次
> 白花的 owner 时间。** 下面是当天当场跑出来的,不是示意:

```
$ MODE=verify SAMPLE=25 PLAN=<resolve log> PHOTO_DIR=<OUT_DIR>/so \
    node backend/scripts/upload-line-photos-r2.mjs
local done-list: 602 key(s) already uploaded by an earlier run
to upload: 0; already done locally: 602; file not exported: 0
VERIFY: re-reading 25 of 602 uploaded key(s) from R2 on fresh processes
VERIFY: 25 byte-identical to the manifest; 0 present but unverifiable; 0 missing; 0 wrong
VERDICT: PASSED. Attach with import-so-line-photos.mjs / import-po-line-photos.mjs APPLY=1.
```

对照过的还有 R2 的 REST API(`GET /accounts/<acct>/r2/buckets/houzs-erp/objects/<key>`,
`HEAD` 回 405 所以要用 GET):8 月 31 日算出来的 840 个 key 全部 `200 image/jpeg`,
随手编的假 key 回 `404 {"code":10007}` —— **判别器是活的,不是对什么都回 200。**

四道闸门也实测过会拒(错格式 key / 无确认句 / 错确认句 / 没 token 档,四个都 exit 2)。

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

#### 完成实录 — 2026-09-07 上线日,照片这一段收尾

这一段是**做完了**的记录,数字全部是当天从 R2 和 prod 读回来的,不是打算做的事。

| 关卡 | 结果 |
|---|---|
| 上传 R2 | **850 / 850**,失败 0 |
| `MODE=verify` **整批**(不是抽样) | **850 / 850** 位元组和 manifest 完全一致;缺 0、错 0、无法核对 0 |
| 挂回 ERP | SO **610 / 610** key、PO **240 / 240** key;再跑一趟 `apply=1` 印 `already attached: 610 / 240`、`keys attached: 0`(幂等确认) |
| 账本有照片、ERP 也有这一行 | SO **517 / 517 到位**、PO **222 / 222 到位**,两边 **missing 都是 0** |

上线前那次是 SO 到位 510(缺 7)、PO 到位 221(缺 1);现在两边都归零。

**整批核对怎么跑得完**:`MODE=verify` 一次只抽 `SAMPLE` 把 key,而且每读一个 key
就要开一个 wrangler 行程,850 个串著跑要一个多钟头。做法是把 resolve 的计划档
**切成几段**,每段当一个独立的 `PLAN` 喂给 `MODE=verify`,`SAMPLE` 设得比那段大,
几段同时跑——各段的联集就是整批,脚本一个字都不用改。当天切成 SO 5 段 + PO 2 段,
七个行程并行,**12 分钟**跑完 850 个 key。

**挂不上的那些,原因说清楚**(`probe-line-photo-gap.yml` 印的就是这张表):

| | SO | PO |
|---|---|---|
| 账本拍了照的行 | 2,761 | 2,409 |
| ERP 根本没有这一行 | 2,244 | 2,187 |
| ├ 整张单当初就没迁进来(cutover 只搬未结清的单) | 2,151 | 2,185 |
| └ 单在、行对不上 | 93 | 2 |
| ERP 有这一行 | 517 | 222 |
| └ **照片已到位** | **517** | **222** |

所以剩下的缺口**不是照片没搬**,是那些单据本来就不在 ERP 里。要它们的照片,得先把
那些单迁进来,不是再跑一次照片。

> 另外记一笔:`probe-line-photo-coverage.yml` 数的是**行(row)**,
> `probe-line-photo-gap.yml` 数的是**账本的那一行(line)**。一张沙发是账本一行、
> ERP 好几行,照片按规矩只挂第一行,所以 coverage 那张表会看到 SO 322 / PO 134 个
> row「没照片」——那是**设计如此**,不是缺口。看缺口请看 gap 那张。
> 还有 SO 有 **124 行带著照片但没有 AutoCount 行号**,上面这个漏斗看不到它们。

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

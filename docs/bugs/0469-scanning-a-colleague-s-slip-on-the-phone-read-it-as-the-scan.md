## Scanning a colleague's slip on the phone read it as the scanner's handwriting [medium]

<!-- area: Sales orders + pricing -->

**白话.** 扫描单据时送出去的那个「销售员」名字，是 **OCR 的学习 key**：后台会拿**那个
人**的笔迹规则和范例去读这张单（`loadPromptInjections(svc, job.salesperson)`），读完的
学习样本也归档在那个名字底下，「最近扫描」也是照它筛。电脑版的扫描窗口把它预设成登入的
人（多数情况没错），但**留着可以改**，后面接 `GET /scan-so/salespeople` 的名单 ——
因为常常有人帮同事扫。手机版那格是写死的登入者：没有输入框、没有名单。办公室的人一叠
同事的单扫下去，每一张都用**自己**的笔迹习惯去读，同事的更正也全教进自己的规则档。
现在手机那格跟电脑一样可以改，名单也是同一个。

**这一格不是佣金。** 订单自己的 `salesperson_id` 是**后台**照登入者盖的
（`resolveScanUploaderStaffId`，`scan-so.ts:4270` → `scan_jobs.salesperson_id`），
两个界面都一样、都不信任 client 传来的值。把这条讲成「修好佣金」是这棵树支撑不了的说法。

**Symptom.** An office person working through a stack of colleagues' slips can
name the writer at the desk and cannot on the phone, so every slip in the stack
is read against the scanner's own handwriting rules.

**Root cause.** `MobileScan.tsx` had `const salesperson = (user?.name ||
user?.email || "").trim();` — a constant, no setter, no known-reps list — and
that single value rides both `/scan-so/extract` and `/scan-so/enqueue`.

**What it actually decides, traced rather than assumed.** `repGiven` (the field)
feeds `loadPromptInjections` on both the synchronous `/extract` path (`:3061`)
and the background job (`:3973`, off `scan_jobs.salesperson` written at `:4303`),
keys the `so_scan_samples` row (`:3072`), and filters `GET /scan-so/jobs`. The
SO's own salesperson is NOT caller-trusted on either surface — `salesperson_id`
comes from `resolveScanUploaderStaffId` on the authed request.

**Fix.** `MobileScan` now holds it as state, defaulted to the signed-in user and
editable against the SAME list desktop offers. `SCAN_SALESPEOPLE_PATH` and
`normalizeScanSalespeople` were added to the already-shared
`vendor/scm/lib/scan-jobs.ts` (the module both scan surfaces already read for
the jobs poll) and `ScanOrderModal` was moved onto them, so the endpoint is
named once and neither surface can offer a different list. A malformed answer is
an empty datalist and never a throw — the field is free-text either way.

**Test.** `frontend/src/mobile/mobile-scan-attribution.test.ts` — unit tests for
the normaliser plus a source contract that the mobile value is editable state
rather than a constant off the signed-in user, and that both surfaces read the
one endpoint constant. Run RED first: `MobileScan still hard-codes the scanner
as the salesperson`.

---

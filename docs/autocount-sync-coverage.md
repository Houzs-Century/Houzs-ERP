# ERP -> AutoCount sync: coverage, gaps, and the build plan

> ## SUPERSEDED IN ITS CONCLUSIONS — read this box before you quote anything below
>
> **Checked against the code on `main` and against production, 2026-08-12.** This
> document is a good assessment of what was true on **2026-08-11**, and its
> reasoning about mechanisms is still worth reading. **Its headline conclusions are
> not true any more**, and it was already being quoted as though they were. For
> current status use `tasks/AUTOCOUNT-GOLIVE-HANDOFF.md`; for the shape of the whole
> integration use `docs/autocount-integration-map.md`.
>
> | This document says | Verified on 2026-08-12 |
> |---|---|
> | §0 Blocker 2: create returns only `DocNo`, so an edit appends duplicate lines | **FIXED.** Every create/convert route now answers with the created line keys — `Ok(docNo, CreatedLines(dtlTable, docNo))`, `AcSyncService.cs`, reading `DtlKey`/`ItemCode`/`Desc2` straight from the book's detail table |
> | §0 Blocker 2: `/edit` treats a keyless line as new (`AddDetail`) | **FIXED.** A keyless line is now REFUSED unless the ERP asserts `IsNewLine` (`AcSyncService.cs`, the keyless-line guard; PRs #1935 + #1945). Line identity in prod is 92.8% on SO, not 0% |
> | §0 Blocker 1: no non-destructive way to retire a line | **BUILT**, and by the mechanism this document recommended: `Retire:true` sets `Qty = 0` + `Transferable = false` + a `[ERP-CANCELLED]` marker in `Desc2`. The ERP reads the line's `DtlKey` BEFORE deleting the row (`retiredLineOf`, `autocount-outbox.ts`) so the removal can be named |
> | §1.1: the write-back is "NOT WIRED, NOT DEPLOYED, NOT CONFIGURED"; `AC_SYNC_URL` commented out | **False now.** `AC_SYNC_URL` is set (`backend/wrangler.toml:42`, PR #2030) and the tunnel answers: unauthenticated `POST /health` -> `401 {"ok":false,"error":"bad key"}` |
> | §1.4: PR #1855 is OPEN, the ERP half is unmerged | **Merged** 2026-08-10 |
> | §2: "No cell anywhere is PROVEN" | **Five cells are PROVEN** against the live `AED_HOUZS` book: `create-so`, all four `/edit` guards, `so-to-do`, `cancel` SO + DO. `create-po` is blocked on `FK_PO_PurchaseAgent`, fixed in code but not yet on the host |
>
> **What has NOT changed, and is the thing to hold on to:** the DB toggle
> `scm.app_config` -> `scm.autocount_writeback` is still `off`, and
> `scm.autocount_outbox` still holds **zero rows of any status** — verified
> 2026-08-12 by running `.github/workflows/autocount-outbox-health.yml`, which
> reported `QUEUE EMPTY`. **No ERP document has ever reached AutoCount.** Anyone
> asking "is it synced yet" should run that workflow rather than read a document.

**Assessment date: 2026-08-11.** Scope: the owner's go-live blocker #1 —

> "我们的 Sales Order、PO、DO、GR、PI、SI 等所有单据,无论是我打开后进行 Convert
> 还是 Edit 等操作,全部都要能 Sync 到 AutoCount。这是最基础的。"

Narrowed the same day by the owner to a shippable slice:

> "你要确保 Edit Sales Order 还有 Create Sales Order 在 ERP 都可以直接 Sync 到
> AutoCount。尤其是 Create、Edit 还有 PO、SO 最重要,如果这两个都解决掉,我就可以先上线了"

and constrained by two standing rules issued the same day:

> **"不可以删只可以 cancel"** — nothing is ever deleted, on either side. Cancel is the
> only retirement mechanism.
>
> **"暂时只可以在 erp 改"** — for now documents are edited only in the ERP. AutoCount
> is a follower, not an editing surface.

This document is an ASSESSMENT. It changes no behaviour. Every non-empty matrix cell
cites a file and a line. Where something is inferred rather than observed it is
labelled **(inference)**.

Companion documents: `docs/modules/autocount-writeback.md` (the design, on the
unmerged branch), `docs/autocount-cutover-ledger.md` (the one-time import that came
the other way).

---

## 0. The blocker, stated first

**Two defects sit between the ERP and the owner's P0 slice. Both are in the EDIT path,
and both are the kind that corrupt a live account book rather than fail loudly.**

**Blocker 1 — a line can be removed in the ERP and there is no way to retire it in
AutoCount without deleting it, which is now forbidden.**

No detail class in the AutoCount 2.2 SDK has a `Cancelled`, `Void` or `Status`
property. A whole-file grep of the reflected surface
(`backend/scripts/autocount-service/sdk-api-reference.txt`) for `Cancelled:` on any
detail type returns nothing. Only ONE of the six document classes exposes
`DeleteDetail(Int64)` at all — `AutoCount.Invoicing.Sales.SalesOrder.SalesOrder`
(line 465). `PurchaseOrder` (441), `PurchaseInvoice` (449), `GoodsReceivedNote` (457),
`Invoice` (473) and `DeliveryOrder` (481) have no line-removal method whatsoever.

So for a PO — half of the owner's P0 — AutoCount offers neither a delete nor a cancel
at line level. **There is no native "retire this line" concept to sync to.**

What the SDK *does* offer on every detail class, confirmed in the same reference:

| Property | Effect | Available on |
|---|---|---|
| `Qty` (`Nullable\`1`) | Set to 0: the line survives, contributes nothing to the document total and nothing to the outstanding set | SalesOrderDetail, PurchaseOrderDetail, and every other detail class |
| `Transferable` (`Boolean`) | Set to false: the line can no longer be transferred downstream | same |
| `PrintOut` (`Boolean`) | Set to false: the line stops appearing on the printed document | same |
| `Description` / `Desc2` | Free text — can carry a human-readable "CANCELLED <date> <user>" marker | same |

**Recommended mechanism (owner decision, my recommendation attached):** retire a line
as `Qty = 0` **plus** `Transferable = false` **plus** a `Desc2` marker. The reason to
lead with `Qty = 0` rather than `Transferable = false` is arithmetic, not taste:
AutoCount's own outstanding test is `Qty - ISNULL(TransferedQty, 0) > 0`
(`AcSyncService.cs:321`). Only `Qty = 0` makes that expression agree with an ERP line
that no longer exists. `Transferable = false` leaves `Qty` intact, so the raw
outstanding arithmetic still counts the line — it is a useful belt-and-braces guard
against a human transferring it in the AutoCount UI, but it cannot carry the
requirement on its own. **(inference:** that AutoCount's own outstanding *reports*
honour `Transferable` is likely but unverified — settle it in the test book, not by
reasoning.**)**

**The ERP side has the mirror-image problem and it is not hypothetical.** The ERP
hard-DELETEs line rows today: `mfgSalesOrders.delete('/:docNo/items/:itemId')` at
`backend/src/scm/routes/mfg-sales-orders.ts:8350`, executing
`sb.from('mfg_sales_order_items').delete()` at `:8403`. Under "不可以删只可以 cancel"
that is now a defect in its own right, and it is also why the sync cannot be written:
once the row is gone the ERP cannot tell AutoCount *which* line to zero. A soft-cancel
column on the line tables is therefore a prerequisite for the edit path, not a nicety.

**Blocker 2 — the line identity the edit path is built on does not exist in
production, and will not exist for new documents either.**

Migration 0273 (`backend/src/db/migrations-pg/0273_scm_ac_line_keys.sql`, merged as
PR #1819) adds `linked_ac_dtlkey` to `mfg_sales_order_items` and
`purchase_order_items`. It is the only handle `/edit` has —
`doc.EditDetail(dtlKey)` at `AcSyncService.cs:396`.

It is empty. Commit `ffbddce8` records a production run that disproved the premise:

> "It was never backfilled: 0 of 496 migrated GRN lines, 0 of 59 migrated DO lines and
> 0 of 864 cutover PO lines carry it."

The backfill exists (`backend/scripts/backfill-ac-line-keys.mjs` plus
`.github/workflows/backfill-ac-line-keys.yml`) and has never been run against
production.

**The worse half is that running it does not fix the future.** `/create-so` and
`/create-po` return only the document number — `return so.DocNo;`
(`AcSyncService.cs:190`), wrapped by `Ok(docNo)` at `:142`. The created lines' DtlKeys
are never sent back. So every SO the ERP creates after go-live has `NULL` in
`linked_ac_dtlkey` on every line, and `/edit` treats a line with no DtlKey as a new
line: `d = doc.AddDetail()` at `AcSyncService.cs:399`.

**Consequence, stated plainly: with the code exactly as it stands, creating a Sales
Order and then editing it would APPEND a duplicate set of lines into the live account
book rather than update the originals.** That is precisely the owner's P0 pair —
create then edit — and it is the single most damaging thing in this assessment. It
needs a change on the AutoCount side (return the DtlKeys from the create routes, or
add a route to read them back) which can only be compiled and tested on the AutoCount
host.

Nothing in the ERP is currently wired to send any of this, so no damage has occurred.
The mechanism ships dark. See §1.

---

## 1. What actually exists today

### 1.1 Three integrations, easily confused

| # | What | Transport | State |
|---|---|---|---|
| 1 | **Legacy read middleware** — `AutoCountClient`, `backend/src/services/autocount.ts:39` | `https://it-houzs.dev/` (`backend/wrangler.toml:15`), Cloudflare-proxied to the office | **LIVE.** Inbound pulls on (`AUTOCOUNT_SYNC_DISABLED = "false"`, `wrangler.toml:24`). Its own two write methods are hard-off by a compile-time constant `AUTOCOUNT_WRITES_DISABLED = true` (`autocount.ts:28`) |
| 2 | **Cutover analysis path** — direct SQL to `10.147.17.100,55500` over ZeroTier via pyodbc | ZeroTier from a workstation | Read-only, ad hoc, not a runtime path. Appears nowhere in the repo |
| 3 | **The write-back** — `AcSyncService.cs`, the .NET 4 service driving the licensed 2.2 SDK on the AutoCount host | `AC_SYNC_URL`, **commented out** at `backend/wrangler.toml:34` | **NOT WIRED, NOT DEPLOYED, NOT CONFIGURED** |

A correction worth recording, because a merged PR body asserts otherwise: PR #1898's
description says `services/autocount.ts:249` "writes `POUDF_EDate` to the live book
today". It does not. `pushPODates` short-circuits on `AUTOCOUNT_WRITES_DISABLED`
(`autocount.ts:253-259`) and returns a synthetic
`"skipped: AUTOCOUNT_WRITES_DISABLED"`. The file is still valid evidence for the
`POUDF_*` naming convention, which is what it was cited for; it is not evidence of a
live write.

### 1.2 `autocount-sync-api` is the ERP backend, not a sync service

The Workers at `autocount-sync-api.houzs-erp.workers.dev` and its `-staging` twin are
**the ERP's own Hono backend**, carrying a legacy name from when the project was only
an AutoCount sync dashboard. `backend/wrangler.toml:1` is `name = "autocount-sync-api"`;
`docs/CODEBASE-MAP.md:34` describes it as "Cloudflare Worker (`autocount-sync-api`),
Hono. The ONLY writer of business data."

Verified live on 2026-08-11: `GET https://autocount-sync-api.houzs-erp.workers.dev/`
returns `{"ok":true,"service":"autocount-sync-api"}`, HTTP 200. That is the ERP
answering, and it tells us nothing about AutoCount coverage. **These Workers do not
sync anything to AutoCount.** The name is a trap for exactly this kind of audit.

### 1.3 The office-side relay, which is the real single point of failure

A Cloudflare Worker cannot join a ZeroTier network, so ZeroTier is not and cannot be
the transport for anything the ERP does at runtime. The bridge that exists is
`it-houzs.dev`.

Verified live on 2026-08-11:

| Probe | Result |
|---|---|
| `HEAD https://it-houzs.dev/` | HTTP 404, `Server: cloudflare`, `CF-RAY: ...-KUL` |
| `GET https://it-houzs.dev/SalesOrder/getAll` | **HTTP 401** |

A 401 rather than a 502 means the middleware behind the tunnel is running and
answering right now. The `Server: cloudflare` header with a Kuala Lumpur PoP indicates
the hostname is Cloudflare-proxied through to the office box **(inference:** most
likely a `cloudflared` tunnel; no tunnel config exists anywhere in this repo, so the
configuration lives on the office machine and is undocumented here — that gap is
itself a finding**)**.

**This relay is the component to reason about, not ZeroTier.** The owner's
"zerotier 只能保证不断" mitigation addresses a link the runtime path does not use. The
runtime path is: Cloudflare Worker -> `it-houzs.dev` -> tunnel -> office host. The
write-back would need the same shape pointed at `AcSyncService` on port 8900, and
**that tunnel route does not exist yet.** Standing one up is a prerequisite, and the
proven pattern to copy is the one already carrying the reads.

### 1.4 The ERP half: fully designed, entirely unmerged

An independent search of `main` confirms: **the ERP backend has zero runtime code
paths that call the write-back service.** Not from `backend/src`, not from a cron, not
from a script. On `main` the only artifacts are `AcSyncService.cs` itself, the SDK
reference, and four nullable columns (0271, 0273, 0276) that no TypeScript reads.

Everything else lives in two open PRs:

| PR | Branch | State | What it is |
|---|---|---|---|
| **#1855** | `feat/ac-writeback-wiring-v2` | **OPEN**, +3506/-190 | The whole ERP half: `scm.autocount_outbox` (migration 0277), enqueue hooks in six route files, the drain cron, the runtime toggle, and the downstream lock |
| **#1898** | `test/ac-writeback-trial` | **OPEN**, stacked on #1855 | 33 contract tests derived from the C# source, a gated test-book trial harness, and `docs/modules/autocount-writeback.md` |
| #1819 | merged 2026-08-10 | **MERGED** | Migration 0273 only — the line-key column, never populated |

The design is good and should be merged, not rewritten. Two gates keep it dark:
`AC_SYNC_URL` unset, and `scm.app_config` key `scm.autocount_writeback` seeded `'off'`
by 0277. Both must be opened for anything to reach the live book.

### 1.5 What has actually touched the live book

Exactly one thing: on 2026-08-07 a predecessor program (`AcSoService.cs`, create-SO
only) wrote two real-format Sales Orders — SO-2608-001 (AKEMI) and SO-2608-002 (a
sofa) — into the live `AED_HOUZS` book, invoked **by hand**, not by the ERP. They were
deliberately left uncancelled for the owner to inspect.

That proves the SDK approach works headless under the licence. It does **not** prove
any ERP flow, because no ERP flow was involved.

---

## 2. The coverage matrix

Read END-TO-END: "can a user's action in the ERP land in AutoCount". A cell is only as
strong as its weakest half.

Legend — **PROVEN** = built and demonstrated against the live book · **BUILT** = code
exists on both sides but has never run end-to-end · **DESIGNED** = written down, code
missing on at least one side · **NOTHING** = no path exists (the SDK merely *could* do
it counts as NOTHING).

The DELETE column is deliberately absent. Per "不可以删只可以 cancel", delete is not a
capability we want; CANCEL replaces it.

| Doc | CREATE | CONVERT (in) | EDIT | CANCEL |
|---|---|---|---|---|
| **SO** | BUILT | n/a (no parent) | **NOTHING** | BUILT |
| **PO** | BUILT | n/a (no parent) | **NOTHING** | BUILT |
| **DO** | NOTHING | BUILT (SO->DO) | NOTHING | BUILT |
| **GR** | NOTHING | BUILT (PO->GR) | NOTHING | BUILT |
| **SI** | NOTHING | BUILT (DO->IV) | NOTHING | NOTHING |
| **PI** | NOTHING | BUILT (GR->PI) | NOTHING | NOTHING |

**No cell anywhere is PROVEN.** The only live-book evidence is a manual SO create by a
program that is no longer the one being shipped.

### 2.1 Evidence per cell

| Cell | Verdict | Evidence |
|---|---|---|
| SO CREATE | BUILT | AC half `AcSyncService.cs:154` `CreateSo`; ERP half `enqueueSoCreate` at `scm/routes/mfg-sales-orders.ts:5492` (#1855). Blocked by divergence D10 (item code) and D9 (sofa) — see §3.7 |
| PO CREATE | BUILT | `AcSyncService.cs:193` `CreatePo`; `enqueuePoCreate` at `scm/routes/mfg-purchase-orders.ts:1380` |
| SO EDIT | **NOTHING** | AC half `AcSyncService.cs:352` `Edit` is update-in-place and correct in shape; ERP half `queueAcSoEdit` at `mfg-sales-orders.ts:258` and five call sites. Scored NOTHING **not** for absence of code but because both blockers in §0 sit on it: line identity is NULL so an edit appends duplicates (`AcSyncService.cs:399`), and line removal has no non-destructive representation. Code that would corrupt the book is not coverage |
| PO EDIT | **NOTHING** | Same, `queueAcPoEdit` at `mfg-purchase-orders.ts:250`. Worse than SO: `PurchaseOrder` has no `DeleteDetail` at all (reference line 441) |
| DO / GR / SI / PI CREATE | NOTHING | `AcSyncService` has no `/create-do`, `/create-gr`, `/create-iv`, `/create-pi` (route table, `AcSyncService.cs:131-140`). A DO raised in the ERP without a parent SO has no path |
| SO->DO | BUILT | `Convert_("SO","DO")` `AcSyncService.cs:231`; `enqueueConvert` at `scm/routes/delivery-orders-mfg.ts:3407,3942` |
| PO->GR | BUILT | `AcSyncService.cs:249`; `scm/routes/grns.ts:1953,2314` |
| DO->IV | BUILT | `AcSyncService.cs:240`; `scm/routes/sales-invoices.ts:1338` |
| GR->PI | BUILT | `AcSyncService.cs:259`; `scm/routes/purchase-invoices.ts:1679,1858` |
| SO / PO / DO / GR CANCEL | BUILT | `AcSyncService.cs:332` `Cancel`; `enqueueCancel` at `mfg-sales-orders.ts:5818`, `mfg-purchase-orders.ts:4149`, `delivery-orders-mfg.ts:5228`, `grns.ts:2545` |
| SI / PI CANCEL | **NOTHING** | `sales-invoices.ts` and `purchase-invoices.ts` import only `enqueueConvert` and `recordConvertSkipped` (`sales-invoices.ts:58`, `purchase-invoices.ts:26`). No cancel hook exists. The AC half would serve it — `AcSyncService.cs:341,344` — but nothing calls it |
| DO / GR / SI / PI EDIT | NOTHING | No `enqueueEdit` import in any of those four route files |

---

## 3. The hard parts

### 3.1 Identity at document level — works, conditionally

`scm.mfg_sales_orders.linked_ac_docno` (migration 0271) is populated for every
imported SO and is the cutover ledger's signature #1. Migration 0277 (#1855) adds the
same column to `purchase_orders`, `delivery_orders`, `grns`, `sales_invoices` and
`purchase_invoices`. The drain writes AutoCount's answer back onto the ERP row, so the
map is traceable both ways.

For a document created after go-live the ERP sends its own `DocNo` and AutoCount
accepts it (`so.DocNo = Str(p, "DocNo")`, `AcSyncService.cs:157`), so the two numbers
are the same string and identity is trivially stable.

The gap is conversions: they deliberately do not send a `DocNo` (divergence D5), so
AutoCount auto-numbers every DO, GRN, invoice and PI. Four of the six flows therefore
carry two different numbers for one document. That is survivable because the drain
records `ac_doc_no` back — but only if the drain succeeded. Verdict: **document
identity is sound.**

### 3.2 Identity at line level — does not work

Covered in full in §0, Blocker 2. Summary: the column exists, production is empty
(0 of 496 / 0 of 59 / 0 of 864, commit `ffbddce8`), the backfill has never run, and
the create routes do not return DtlKeys so new documents will be empty too. **An edit
path is impossible until this is fixed on both sides.**

### 3.3 Convert — the link is real, and this is the good news

The question was whether the write-back reproduces AutoCount's own document link or
creates orphans that look right and reconcile wrong. **It reproduces the real link.**

There is no `TransferTo`/`CreateFrom` API. Every document class exposes exactly one
transfer primitive, `AddPartialTransferDetail(fromDocType, fromDocDtlKeys, bool)`, and
the service uses it (`AcSyncService.cs:235,244,253,263`). The SDK writes the
`DocTransfer` bookkeeping itself; the detail classes expose no settable `From*` fields,
so the link **cannot** be faked by hand even if someone tried. `fromDocType` uses the
literals the live book already stores in `DODTL/GRDTL/IVDTL/PIDTL.FromDocType`
(`AcSyncService.cs:22-23`). Converted documents will be genuine children, and
AutoCount's own outstanding reports will see them as such.

Three real caveats:

**(a) One source document only.** The ERP can merge N Sales Orders into one DO, or N
POs into one GRN. AutoCount has no shape for that. Handled honestly rather than faked:
`recordConvertSkipped` writes a `skipped` outbox row with the reason
(`autocount-outbox.ts:377`, called at `delivery-orders-mfg.ts:3953`, `grns.ts:1964,2325`,
`sales-invoices.ts:1349`, `purchase-invoices.ts:1690`). A divergence that is written
down can be found. This is the right call, but it means **merged conversions will
never reach AutoCount and someone must work that backlog by hand.**

**(b) A partial conversion becomes a full one. This is a divergence I do not find in
the existing D1-D13 register, so recording it here as D14.** `enqueueConvert` sends no
`DtlKeys`, by an explicit decision documented in its own comment
(`autocount-outbox.ts:352-357`): AutoCount's book is the authority on which lines are
already transferred. The consequence is that `AcSyncService` falls through to
`DtlKeys()` (`AcSyncService.cs:300`) and selects **every** still-outstanding line on
the parent. But the ERP has genuinely line-level conversion routes —
`POST /from-po-items` (`grns.ts:2314`) and `POST /from-grn-items`
(`purchase-invoices.ts:1679`) exist precisely to convert a subset. So an ERP DO
shipping 2 of 5 lines would produce an AutoCount DO containing all 5, moving stock in
AutoCount that did not move in the ERP. **(inference** on the operational impact; the
code path is observed, the frequency of partial conversion in practice is not
something I measured**)**. This is P2 scope, but it must be fixed before conversions
are enabled, and it re-introduces the need for line keys on the convert path.

**(c) Over-transfer is refused, silently.** The SDK raises a WinForms dialog for
over-transfer; the service answers it programmatically with `IsConfirmed = false`
(`AcSyncService.cs:276-278`). Refusing is the right default, but combined with (b) it
means a conversion can fail for a reason the ERP user will never see.

### 3.4 Edit — update-in-place, which satisfies the owner's rule

The question was whether `/edit` is update-in-place or delete-and-recreate, and under
"不可以删只可以 cancel" delete-and-recreate would have been a design defect.

**It is update-in-place, and it is correct in shape.** `Edit(docNo)` returns the live
document (`AcSyncService.cs:359-364`); a line carrying a DtlKey is fetched with
`doc.EditDetail(dtlKey)` and mutated (`:396`); only a line with no DtlKey is appended
(`:399`). The document keeps its `DocKey`, its transfer links and its audit trail. The
service's own comment already refuses to offer line deletion, and gives a reason that
happens to anticipate the owner's rule (`AcSyncService.cs:386-391`).

So the mechanism does not need redesigning. What it needs is the two fixes in §0:
line keys that actually exist, and a non-destructive line-retirement representation.

Two further edit-path divergences, from the #1898 register, both material to P0:

- **D6** — on a line addressed by DtlKey the service never applies `ItemCode`
  (`AcSyncService.cs:395-401` applies it only on the append branch). The ERP's
  `tbc-swap` / `tbc-swap-sofa` routes change the product and are hooked to
  `enqueueEdit`. A SKU swap would change the description and the price and leave the
  old product in AutoCount. **This is a P0 defect: it is an Edit Sales Order operation
  the owner explicitly named.**
- **D8** — `Agent`, `SalesLocation`, `DocDate` and `UDF` are all in the C# allow-list
  and none is composed by the ERP, so changing the salesperson, sales location, order
  date, branding or venue on a live order never reaches AutoCount.

### 3.5 Cancel — now the only retirement mechanism, and it is asymmetric

**How AutoCount represents it.** `CancelDocument(docNo, userID)` is a COMMAND, not a
flag — `InvoicingCommonCommand` (reference lines 21-22), used at
`AcSyncService.cs:339-344`. Setting `Cancelled` on the entity would bypass AutoCount's
transferred-document guards, which is why the service does not. It returns a boolean
and the service throws when it is false (`:347`), so a refusal is loud rather than
silent.

**How the ERP represents it.** `PATCH /:docNo/status` to `CANCELLED`, described in
`docs/modules/sales-order.md:114` as "a reversible audited status change".

**The asymmetry, which is a genuine finding.** The SDK has **no un-cancel**. A grep of
the whole reflected surface for `uncancel`, `Cancelled:Boolean` and `set_Cancelled`
returns nothing; `InvoicingCommonCommand` offers `CancelDocument` and `Delete` and
nothing that reverses a cancel. **So an ERP un-cancel cannot be pushed.** The ERP
allows an operation AutoCount cannot follow. Options: (a) make ERP cancel irreversible
once synced, (b) allow un-cancel and require a human to fix AutoCount, (c) represent
un-cancel as a new document. My recommendation is **(a)** — make it irreversible once
`linked_ac_docno` is set, because it is the only option that cannot silently diverge,
and it matches what AutoCount itself enforces. Owner decision, logged in §6 as Q4.

**AutoCount refuses to cancel a transferred document**, and the ERP now mirrors that
rule deliberately — the downstream lock, `backend/src/scm/lib/downstream-lock.ts`
(#1855), enforcing the owner's own 2026-08-10 instruction
("已经转到下游的单据, AutoCount 不许取消/改动"). Good: the two systems refuse the same
things for the same reasons.

**The failure case the owner named — "一边取消一边没取消".** Today, with the wiring
merged and enabled, an ERP cancel whose push fails would retry six times
(`MAX_ATTEMPTS = 6`, `autocount-outbox.ts:46`), then set `status = 'failed'` and emit
`console.error("[cron ac-writeback] FAILED ...")` (`backend/src/index.ts:530`). That
is a log line in Cloudflare's tail. **There is no pending-cancel state, no
reconciliation sweep, and no alarm.** The document reads CANCELLED in the ERP and
stays live in AutoCount, and the only way anyone finds out is by running a SQL query
nobody is scheduled to run. That is exactly the divergence the owner asked to have
solved, and it is unbuilt. §4 step 4 is the fix.

One thing the design already gets right: `enqueueCancel` marks a still-pending create
`skipped` rather than creating a document in a live account book only to cancel it
(module guide §6).

### 3.6 Drift detection — the ERP-only-editing rule needs enforcement or detection

The owner's "暂时只可以在 erp 改" removes the bidirectional conflict problem: this is a
one-way push, ERP master, AutoCount follower, and no merge semantics are needed. That
is a large simplification and the design should take it.

But staff have used AutoCount for years and will edit there out of habit. A rule that
is only a rule will be broken, and a one-way push has no way to notice: the next ERP
edit simply overwrites whatever a human typed, silently.

**What exists.** `backend/scripts/check-autocount-parity.mjs` (on `main`, with
`.github/workflows/check-autocount-parity.yml`) compares the two systems read-only on
four axes the owner named — PO number vs `SO.UDF_ToPONo`, stock status vs
`SO.Remark2`, balance vs `SO.UDF_BALANCE`, and the SO -> PO -> GR chain. It is a real
foundation and it already runs against the live data.

**What is missing.** It does not detect an *edit*: no checksum over the fields the ERP
owns, no poll of AutoCount's `LastModified`, no per-line comparison. Nothing tells us
that someone changed a price in AutoCount yesterday.

**Recommendation, both halves.** *Detect* first, *lock* second. Detection is cheap and
tells us how big the habit actually is: extend the parity checker into a scheduled
field-level diff over the documents the ERP owns (`linked_ac_docno IS NOT NULL`),
reporting rows where AutoCount disagrees with the ERP on a field the ERP is master of.
Locking AutoCount down by user permission is the durable answer, but doing it before
the write-back is proven would leave staff with no working editing surface at all if
the push turns out to be unreliable. So: detect from day one, lock once the ERP path
has been trusted for a couple of weeks. Owner decision, logged as Q5.

### 3.7 Transport and failure

**The happy path** is Worker -> `it-houzs.dev` -> office tunnel -> AutoCount host, and
for the write-back that route **does not exist yet**: `AC_SYNC_URL` is commented out
(`wrangler.toml:34`) and `AC_SYNC_KEY` is documented as NOT SET (`wrangler.toml:223-229`).

**Say this plainly in front of the owner, because it is the argument that justifies
the work:** the durable queue is not there because we distrust ZeroTier or the tunnel.
It is there to make failure VISIBLE. Even a well-run link drops for a patch reboot,
and the one outcome that must be impossible is a save that succeeds in the ERP while
its sync is silently lost. A queue turns that from an invisible data divergence into a
row with a `last_error` and a growing backlog somebody can see.

**What #1855 already builds, and it is good:**

| Need | Status |
|---|---|
| Durable queue | `scm.autocount_outbox`, migration 0277. One row per intended operation, rows never deleted — the audit trail of what the ERP told AutoCount |
| A user's save never fails on AutoCount's account | Every enqueue swallows its own errors and returns `false` |
| Retry | Drain on the existing 5-minute cron, `MAX_ATTEMPTS = 6`, `DRAIN_BATCH = 20` (`autocount-outbox.ts:46-47`) |
| Ordering / parent resolution | A row whose parent has not drained is left `pending` **without burning an attempt**; oldest-first so the parent is ahead of it in the same batch |
| Dead-letter | `status = 'failed'` with `last_error`. The row persists |
| Payload integrity | The payload is a snapshot taken at enqueue, never recomposed at drain |
| A failed compose is never sent as an empty document | Writes a `skipped` row carrying the database's message instead — the fix for the D13 class of bug |

**What is missing, and it is the whole alarm layer:**

1. **No alarm.** `console.error` in a Worker is not an alarm; nobody is watching
   `wrangler tail` at 11pm.
2. **No backlog monitor.** Nothing notices that `pending` has been climbing for six
   hours because the tunnel is down. Retry with backoff is present; *noticing that
   retries are not succeeding* is not.
3. **No queue-depth or oldest-pending metric** surfaced anywhere a human looks.
4. **No reconciliation sweep** that independently re-reads AutoCount and asks "does
   every ERP document that should exist there actually exist".

Backoff is worth naming precisely: the current drain retries on a fixed 5-minute cron
rather than an increasing backoff. With `MAX_ATTEMPTS = 6` that means a row gives up
permanently after roughly **30 minutes** of outage. A tunnel down for a long lunch
would dead-letter every document created in that window. **(inference** on exact
timing — it depends on cron scheduling and batch position, but the order of magnitude
is right.**)** Raising the cap and adding real backoff is a small change with a large
effect and is folded into §4 step 4.

### 3.8 Numbering — safe today by coincidence, not by design

The ERP mints `<PREFIX>-YYMM-NNN` — `SO-2608-001` — via `nextMonthlyDocNo`
(`backend/src/scm/lib/doc-no.ts:17`), as `max(suffix)+1` over the month, with a long
comment explaining why `count+1` took down POS order creation on 2026-06-12.

AutoCount's own series is a flat running number: `SO-000021`, `PO-000136` (cutover
ledger §1). The two shapes cannot collide — `SO-2608-001` can never be minted by a
six-digit counter.

But note **why** they cannot collide: the formats happen to differ. Nothing enforces
it. And there is a second-order effect worth writing down: when the ERP supplies its
own `DocNo` on create, **AutoCount's internal next-number counter is not advanced.**
So AutoCount keeps issuing `SO-0000NN` for anything created in its UI, in parallel,
forever. That is fine and arguably desirable — the number tells you which system
authored the document — but it should be a decision, not an accident. Recommendation:
add a startup assertion in the write-back that refuses a `DocNo` matching AutoCount's
native pattern, and record the two-series convention in the module guide. Small, cheap
insurance.

The real numbering risk is elsewhere: conversions do not send a `DocNo` (D5), so an
ERP DO and its AutoCount counterpart have different numbers, and every reconciliation
must go through `linked_ac_docno` rather than matching on the number. That is already
how the design works; it just needs to stay that way.

---

## 4. The build plan

Sequenced so the owner's P0 slice — SO and PO, create and edit — is shippable on its
own. Sizes are rough: S = under a day, M = a few days, L = a week or more.

### Phase 0 — prerequisites for everything (must be first)

| # | Step | Size | Unblocks | Needs owner? |
|---|---|---|---|---|
| 1 | **Merge #1855, then #1898.** Both gates stay shut (`AC_SYNC_URL` unset, toggle `off`). Nothing reaches the book | S | Everything. This code is good and rotting in a stack | No — but see Q1 |
| 2 | **Stand up the tunnel route to `AcSyncService`.** Copy the shape that already carries `it-houzs.dev`. Set `AC_SYNC_URL`, `wrangler secret put AC_SYNC_KEY`. Prove `GET /health` returns `{"ok":true,"book":"AED_HOUZS"}` through the tunnel from a Worker | M | Every push. Nothing else can be tested end-to-end | Owner or IT must configure the office side |
| 3 | **Fix line identity, both halves.** (a) Change `/create-so` and `/create-po` to return the created `DtlKey` per line, and the drain to persist them into `linked_ac_dtlkey`. (b) Run `backfill-ac-line-keys` against production for the migrated documents. (c) Add a gate that refuses an `/edit` whose lines have no DtlKey rather than appending | M | **All EDIT.** Without this, edit corrupts the book | No — but (a) compiles only on the AutoCount host |

### Phase 1 — the owner's P0 slice: SO + PO, create and edit

| # | Step | Size | Unblocks | Needs owner? |
|---|---|---|---|---|
| 4 | **Line retirement without deletion.** ERP: add a soft-cancel column to `mfg_sales_order_items` and `purchase_order_items`; convert the hard-delete routes (`mfg-sales-orders.ts:8350`, PO equivalent) to set it. AutoCount: extend `/edit` to accept a retired line and apply `Qty = 0` + `Transferable = false` + a `Desc2` marker | M | **All EDIT**, and compliance with "不可以删只可以 cancel" | **YES — Q1: confirm the representation** |
| 5 | **Close divergences D10 and D9** (both blocking, from #1898 §11). D10: wire `makeItemCodeResolver` so the AutoCount item code goes on the wire, not the raw ERP `item_code`. D9: collapse a sofa's per-compartment rows to one AutoCount line via `groupSoLinesForDisplay`, or one sofa books qty N and takes N off AutoCount stock | M | **SO CREATE and SO EDIT.** Nothing can be enabled before these | No |
| 6 | **Close D6** — `/edit` must apply `ItemCode` on a DtlKey-addressed line, or a SKU swap leaves the old product | S | SO EDIT correctness (`tbc-swap`) | No |
| 7 | **Alarm and backlog monitor.** Raise `MAX_ATTEMPTS`, add real backoff, and add a scheduled check that alarms on `failed > 0` or oldest `pending` older than N minutes. Route it where a human actually looks. Follow `check-soak-gate.mjs` + `workflow_dispatch` | M | Turning the toggle on responsibly. **The queue without this is a queue nobody reads** | **YES — Q3: where does the alarm go?** |
| 8 | **Cancel convergence.** Add a `pending_cancel` state so a document cancelled in the ERP but not yet confirmed in AutoCount is visibly in-flight; add a reconciliation sweep that re-reads AutoCount and asserts the outstanding sets match (the acceptance test in §5) | M | The owner's explicit "一边取消一边没取消" requirement | **YES — Q4: is ERP un-cancel irreversible once synced?** |
| 9 | **Run the trial harness against `AED_TESTING`.** `ac-trial-dry-run.mjs` with its four gates. Settles D1 (UDF prefix), D2, D4, D5 against a real book — questions the C# source cannot answer | S | Confidence before any live write | Owner must restore the test book and build the service against it |
| 10 | **Enable for Houzs (company 1) and watch one document land.** Toggle `'1'`, create one SO, look at it in AutoCount, edit it, look again | S | P0 go-live | **YES — the go/no-go** |

### Phase 2 — everything else, explicitly later

| # | Step | Size | Notes |
|---|---|---|---|
| 11 | Drift detection: extend `check-autocount-parity.mjs` into a scheduled field-level diff | M | Q5 — detect only, or also lock AutoCount by permission |
| 12 | Fix D14 (partial conversion becomes full) before enabling any convert | M | Needs line keys from step 3 |
| 13 | Enable DO / GR conversions and cancels | M | Already BUILT; needs 12 |
| 14 | SI / PI cancel hooks — currently NOTHING | S | Two enqueue calls |
| 15 | DO / GR / SI / PI edit hooks | M | |
| 16 | Standalone DO / GR create (no parent document) | L | Needs four new routes in `AcSyncService` |
| 17 | Merged conversions (N SOs -> 1 DO) | L | No AutoCount shape exists. May stay permanently manual — see Q6 |
| 18 | Close the remaining silent divergences D2, D3, D4, D8, D12 | M | Individually small |

---

## 5. The minimum viable go-live slice

**Mandatory — the owner cannot go live without these:** steps 1, 2, 3, 4, 5, 6, 7, 10.
That is Phase 0 plus the SO/PO correctness fixes plus an alarm. Steps 8 and 9 are
strongly recommended and cheap relative to what they prevent.

**Genuinely deferrable:** every conversion, every DO/GR/SI/PI operation, and drift
detection. Those run manually or in batch for a while.

### What the owner is actually risking by going live on SO + PO only

This is the most decision-relevant paragraph in the document, so it is stated
directly.

**The good news: the deferred work is a BACKLOG, not a CORRUPTION.** A DO or an invoice
raised in the ERP during the P0 window that never reaches AutoCount leaves AutoCount
holding a Sales Order that still looks fully outstanding. Nothing is written wrongly —
something is merely missing. Because conversions are driven by
`AddPartialTransferDetail` against the parent's *still-outstanding* lines, and because
the parent SO will be correct in AutoCount (that is what P0 buys), the conversion can
be replayed later against the same parent and will produce the correct linked child.
The outbox rows are the worklist: they are never deleted, so the backlog is
enumerable, not archaeological.

**Three specific risks, in descending order of expense:**

1. **AutoCount's outstanding set will overstate reality for the whole window.** Every
   SO shipped or invoiced in the ERP still reads as outstanding in AutoCount. Since
   the owner's own rule for outstanding is "not converted to DO and not to IV", the
   AutoCount outstanding report becomes actively misleading for as long as P2 is
   deferred, and it is the report the business runs on. **Mitigation: keep the window
   short, and until it closes treat the ERP as the sole authority for outstanding —
   say so to staff explicitly.** This is the risk most likely to cause a real-world
   mistake.
2. **Stock in AutoCount will not move.** Deliveries deduct stock in the ERP and not in
   AutoCount, so AutoCount's stock balance drifts by exactly the delivered quantity of
   the window. Repairable by replaying the conversions in order, and cheap to verify
   because the ERP knows what should have moved — but it means AutoCount stock figures
   cannot be trusted during the window either. This is why the owner's own instinct to
   finish the stock-status check before going live ("check 到完它的 stock status,
   然后再上线,那就会更加准") is correct.
3. **Replay must be ordered, and ordering gets harder the longer the window runs.** A
   DO must be replayed before the invoice that came from it. The outbox is
   oldest-first, which handles this automatically — provided the rows were actually
   enqueued. **So enable the conversion enqueues from day one even while the AutoCount
   push for them stays disabled**, so the worklist accumulates in order. This costs
   almost nothing now and saves reconstructing the sequence from audit logs later.
   This is my strongest recommendation in this section.

**What would turn the backlog into real corruption**, and therefore what must not be
shortcut: going live with EDIT before step 3 (line keys) and step 4 (line retirement).
An edit that appends duplicate lines writes wrong data into a live account book, and
under "不可以删只可以 cancel" those duplicate lines cannot be cleanly removed
afterwards — on a PO they cannot be removed at all, only zeroed. **That is the one
shortcut with an irreversible cost, and it sits directly on the owner's P0 path.**

### The acceptance test

One query, run on both sides, must return the same set. AutoCount's definition is
already written in our own code (`AcSyncService.cs:320-322`):

```sql
-- AutoCount side: the outstanding set
SELECT h.DocNo, d.DtlKey, (d.Qty - ISNULL(d.TransferedQty, 0)) AS outstanding_qty
  FROM SODTL d JOIN SO h ON h.DocKey = d.DocKey
 WHERE h.Cancelled = 'F'
   AND (d.Qty - ISNULL(d.TransferedQty, 0)) > 0;
```

The ERP side must produce the same `(document, line, outstanding_qty)` set for every
document where `linked_ac_docno IS NOT NULL`, keyed through `linked_ac_dtlkey`.

**The test passes only if the two sets are EQUAL — not merely overlapping.** Three
cases must each hold, and each corresponds to a failure mode named above:

| Case | Must be true after sync |
|---|---|
| Document cancelled in the ERP | `SO.Cancelled = 'T'` in AutoCount; the document leaves BOTH outstanding sets |
| Line retired in the ERP | `SODTL.Qty = 0` in AutoCount; the line leaves BOTH outstanding sets |
| Document converted in the ERP | `TransferedQty` advanced by exactly the converted quantity; the residue matches on both sides |

Build this as a read-only script plus a `workflow_dispatch` workflow, following
`check-soak-gate.mjs` and the existing `check-autocount-parity.mjs`. Per the repo's
owner rule, do not hand the owner a SQL snippet to run — build the check.

---

## 6. Open questions for the owner

Each has my recommendation attached so work can proceed without waiting.

| # | Question | My recommendation |
|---|---|---|
| **Q1** | How should a retired LINE look in AutoCount? AutoCount has no line-cancel concept — only `Qty`, `Transferable`, `PrintOut` and free text | `Qty = 0` **and** `Transferable = false` **and** a `Desc2` marker "CANCELLED <date>". `Qty = 0` is the load-bearing one because it is what makes the outstanding arithmetic agree |
| **Q2** | Merge #1855 and #1898 now, with both gates shut? | **Yes.** The code is sound, it ships dark behind two independent gates, and a 3,500-line stack rebasing against a moving `main` is its own risk |
| **Q3** | Where should the sync alarm go — email, the ERP dashboard, a phone? | ERP dashboard banner for staff plus email to the owner on `failed > 0`. A log line is not an alarm |
| **Q4** | ERP cancel is reversible; AutoCount has **no un-cancel** in the SDK. Which side gives? | Make ERP cancel **irreversible once `linked_ac_docno` is set**. It is the only option that cannot silently diverge, and it matches what AutoCount itself enforces |
| **Q5** | Should AutoCount editing be locked by permission, or merely detected? | **Detect from day one, lock after two weeks** of the ERP path proving reliable. Locking first leaves staff with no working editing surface if the push disappoints |
| **Q6** | Merged conversions (N SOs -> 1 DO) have no AutoCount shape. Permanently manual, or should the ERP stop allowing merges for AutoCount-linked documents? | Leave them manual and visible as `skipped` rows for now. Revisit only if the volume turns out to be more than a handful a month |

---

## 7. What this assessment did NOT verify

Recorded so nobody mistakes silence for evidence.

- **Nothing was written to AutoCount.** No test document was created. The only live
  probes were `GET /` and `GET /SalesOrder/getAll` against `it-houzs.dev` (a 404 and a
  401) and `GET /` against the ERP Worker.
- **The live `AED_HOUZS` book was not queried.** Claims about production column
  population come from commit `ffbddce8`, which records a production run, not from a
  query run here.
- **`linked_ac_dtlkey` on `mfg_sales_order_items` was not measured.** Commit `ffbddce8`
  reports 0 populated for PO, GRN and DO lines. It does not name SO lines.
  **(inference:** the SO figure is very likely 0 as well, since the same backfill
  covers both and it has never run — but it is unmeasured, and step 3 should measure
  it rather than assume.**)**
- **`AcSyncService.exe` was not observed running.** Its behaviour is read from source.
  It only compiles on the AutoCount host, so none of the C# changes proposed in §4 can
  be verified from this repo.
- **The tunnel configuration for `it-houzs.dev` was not inspected** — it lives on the
  office machine and exists nowhere in this repo. That absence is itself a finding.

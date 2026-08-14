> # ⚠ PARTLY SUPERSEDED — re-verified against the code 2026-08-13
>
> Written against `origin/main @ 0cbf0415`; the tree moved. Thirteen claims were
> refuted by reading the source. **The pattern matters more than the list: this
> document scores things NOT BUILT that are built**, so planning from its
> blocker list understates readiness. The load-bearing ones:
>
> | This doc says | The code says (read 2026-08-13) |
> |---|---|
> | B3 / §5.4: the write-back is a one-shot program — no ERP caller, no queue, no retry | Built: migration `0277` creates `scm.autocount_outbox`; `autocount-outbox.ts` carries enqueue/dispatch/drain with `MAX_ATTEMPTS = 6`; `index.ts:525` drains it on the `*/5` cron; enqueue hooks exist on all six document routers |
> | B9 / step 16: per-module freeze NOT built | Built: `write-freeze.ts:124-183` parses `'<companies> - <area>'` and lifts per area; mapping in `scm-areas.ts`; `set-write-freeze.mjs` takes an `AREAS` input |
> | §3.1: `hu?.is_owner` bypasses the freeze independently | No such flag exists, and `write-freeze.ts:266` says so explicitly. Owner bypass arrives as `'*'` |
> | S1: the 503 body's `reason` is never read by the client | Both sides fixed: backend sends `reason` AND `message` (`write-freeze.ts:310-311`), client reads both (`api/client.ts:206,:212`) |
> | B7: `mfgPurchaseOrders.delete('/:id')` violates never-delete | The endpoint does not exist. The only DELETEs on that router are line-item and allocation |
> | S2 / U2: the UNIQUE index on `inventory_movements` does not exist | `0279_scm_inv_mov_correction_seq.sql:115-118` creates `uq_inv_mov_do_source_v2`, plus three sibling partial uniques |
> | S5: `linked_ac_docno` on `purchase_orders` has no migration | `0277:99` adds it, with the index at `:105` |
> | B8 / U1: there is no marker distinguishing an imported document | `linked_ac_docno` IS the marker — `so-revision.ts:325-326` derives `trustOperatorSelling: 'including-zero'` from it. **Partial**: covers the amendment-approve path only, not the direct save path |
>
> **One item got WORSE, not better, and is now a live risk.** S7 said the cron
> bypassing the write freeze was "correct today, wrong once a sync queue
> exists". The queue now exists. Verified 2026-08-13: `autocount-outbox.ts` has
> ZERO freeze references, the freeze is Hono middleware (`scm/index.ts:113`),
> and the drain runs from `scheduled()` where middleware never executes. Only
> the write-back toggle holds it. Task chip raised.
>
> Every `write-freeze.ts` line cite below is stale — the file was rewritten.

# Houzs ERP — AutoCount Go-Live Readiness

**Date:** 2026-08-11
**Assessed against:** `origin/main` @ `0cbf0415`, deployed successfully (deploy run 31412279868, 2026-08-10 17:05Z).
**Question being answered, in the owner's words:** what is left before staff can edit SOs and POs, raise new SOs, and have AutoCount live-sync, without disrupting daily operations.

This document is an assessment, not a change. Nothing here was applied to production; no
workflow was dispatched; `scm.app_config['scm.write_freeze']` was not touched.

**Where this document is deliberately thin, and why.** Three sibling documents own three
of the areas below and are being produced in parallel. This file cites them rather than
duplicating or second-guessing them:

| Area | Owner document |
|---|---|
| Criterion 1 — the document x operation sync matrix | `docs/autocount-sync-coverage.md` |
| Criterion 3 — ERP vs AutoCount balances, Remark 2 status mapping | `docs/stock-reconciliation.md` |
| Criterion 2 — field-level compartment completeness re-measure | in flight, see §4.2 |

What is distinctly this document's: **the write freeze and whether it lifts in stages**,
**whether the write path is trustworthy at all**, **the sequence**, and **the
daily-operations risk register**.

---

## 1. The verdict

**Not ready, but the gap is narrower and better-shaped than it looks, and the single most
frightening open question turns out to be a false alarm.**

Three findings carry most of the weight:

1. **The write freeze is already per-company and can be lifted in stages today** — for a
   company. Per-MODULE staged lift is not built, but the vocabulary for it already exists
   in the codebase and the change is small and well-bounded (§3.4). This is the one gate
   between today and staff touching the system, and it is in good shape.
2. **The write path staff spend their day in is a different stack from the failing
   script — but seven endpoints are not, and one of them is the sofa colour fill-in.**
   456 of the SCM write calls go through supabase-js/PostgREST over HTTPS, which shares
   nothing with the script's postgres.js-over-TCP and does not touch Hyperdrive at all.
   Exactly **7** endpoints go through a second path that shares the script's driver, its
   `sql.begin()` and its `unsafe()` — including `tbc-update`, which writes *the same jsonb
   keys on the same table* as the script that failed, and **SO cancel** (§4).
3. **Criterion 3 (stock) cannot pass today, and the reason is known and documented.**
   Sofa physical stock was never imported at all, and every one of the 13,881 imported SO
   lines carries no `warehouse_id` — which is also the most plausible mechanical cause of
   the owner's Remark 2 vs ERP status mismatch (§5.3). Both have fix scripts written;
   neither has been applied.

The honest summary: **criterion 2 is close, criterion 1 is unmeasured by me and owned
elsewhere, criterion 3 is the real blocker** — and none of it can be exercised by a human
until the freeze lifts, which is why the freeze is treated first.

---

## 2. The owner's three acceptance criteria

His words, and where each stands.

> 1. 基础单据同步:我们的 Sales Order、PO、DO、GR、PI、SI 等所有单据,无论是我打开后进行 Convert 还是 Edit 等操作,全部都要能 Sync 到 AutoCount。这是最基础的。
> 2. 字段与关系对齐:我们的 Sales Order、PO 等单据的 Compartment 和 variant 全部都一定要对齐,它们之间的对应关系也必须对齐。
> 3. 库存与状态核对:(a) Stock Balance Record 必须对齐。(b) 同时检查 Remark 2(他的 stocks Status)跟 ERP stocks Status 是否对齐;没对齐就要查明原因,因为 by right 它们应该对齐。
>
> "把这些 Bug 全部解决完之后,我们才能上线。"

| # | Criterion | Verdict | The number that proves it |
|---|---|---|---|
| 1 | Every document (SO/PO/DO/GR/PI/SI) syncs to AutoCount on create, convert AND edit | **FAIL — not built** | The write-back is a proven one-shot **program**, not a service the ERP can call. Two orders (`SO-2608-001`, `SO-2608-002`) were written into live `AED_HOUZS` by hand-run SDK code. There is no ERP-side caller, no queue, no retry, no alarm. Coverage matrix: `docs/autocount-sync-coverage.md` |
| 2 | Compartment and variant aligned, and their correspondence aligned | **PARTIAL — company 2 clean, company 1 has 5 defect classes** | Company 2: clean on all four legs (run 31412605952). Company 1 LEG 1 (run 31412356560): **0** code mismatches, **8** builds where the PO is short of pieces the SO has, **16** variant-value differences, **14** children carrying no variants, **181** null `so_item_id`, **1** dangling FK |
| 3a | Stock Balance Record aligned | **FAIL — structurally cannot pass** | Sofa physical stock was **never imported**: prod holds 20 open sofa lots and **0** with a `batch_no`. `import-ac-sofa-stock.mjs` has only ever been DRY-RUN (97 lots / 97 units / 43 batches). Ledger §5 item 14 |
| 3b | Remark 2 (his stock status) aligned with ERP stock status | **FAIL — and the likely cause is identified** | **13,881 / 13,881** imported SO lines have `warehouse_id = NULL`, so every imported line is permanently PENDING and sofa `findCoveringBatch` returns null on sight. Ledger §5 item 13. Measurement owned by `docs/stock-reconciliation.md` |

Criterion 3b's cause is stated here as a **strong hypothesis with mechanical evidence, not
a proven attribution** — the ledger proves the null `warehouse_id` and proves it forces
PENDING; that it accounts for the *specific* Remark 2 rows the owner saw is for the
reconciliation document to confirm.

---

## 3. The write freeze — the gate between today and staff using the system

### 3.1 What it is, verified

`backend/src/scm/lib/write-freeze.ts`, mounted once at `backend/src/scm/index.ts:107` as
`scm.use('/*', scmWriteFreeze())` — deliberately ahead of every SCM sub-router.

Current production state: `scm.app_config['scm.write_freeze'] = '1'` (ledger §5 item 12,
set by run 31353906110). **`'1'` is a company id list, not a boolean.** Houzs (company 1)
is frozen; 2990 (company 2) trades normally through the same deployment.

The task framing said BYPASS_PERMS = `['*','scm.admin']`. **Verified correct**
(`write-freeze.ts:84`). **This paragraph used to claim `hu?.is_owner` bypasses
independently of the permission list. There is no such flag.**
`backend/src/scm/lib/write-freeze.ts:266` says so in the file itself — "there is
deliberately no `is_owner` flag — no identity in this codebase carries one" —
and `callerBypasses` checks `grants(...)` and nothing else. A go-live document
asserting an owner-level bypass that does not exist is the kind of claim someone
plans a cutover around.

### 3.2 Exactly what it blocks, and what it does not

| Blocked | Not blocked |
|---|---|
| Non-GET on `/api/scm/*` — POST, PATCH, PUT, DELETE (`write-freeze.ts:90`) | **GET/HEAD/OPTIONS** — all reads stay open, by design, so the floor can still look things up, print and answer customers |
| …for companies listed in `value` (`write-freeze.ts:98-102`) | **Every other company** — 2990 is untouched |
| …for users without `*`, `scm.admin`, or `is_owner` | **Owner / scm.admin / `*`** — IT can still correct data |
| | **Everything mounted outside `/api/scm`** — `/api/projects`, `/api/assr`, `/api/fleet-maintenance`, `/api/sales`, `/api/finance`, `/api/stockitems`, `/api/announcements`, Mail Center (`backend/src/index.ts:322-373`) |
| | **The pre-auth 2990 mirrors** — `/api/sync/{so,amendment,customer,staff,warehouse}-mirror` are mounted top-level (`index.ts:251-267`), outside the freeze |
| | **The Queue consumer.** `queue()` (`index.ts:741`) is a separate Worker entrypoint; Hono middleware never runs for it, so `processScanQueueMessage` → `createDraftSalesOrder` can still create DRAFT SOs |
| | **The cron `scheduled()` handler** (`index.ts:475`), same reason |
| | **Anything over `DATABASE_URL`** — the cutover's own repair scripts bypass the API entirely, which is intentional |

**Severity of the Queue gap: low, and self-limiting.** `/scan-so/*` is itself mounted
under `/api/scm` (`scm/index.ts:588-589`), so *enqueueing* a new scan job is refused by
the freeze. The consumer can therefore only drain jobs enqueued before the freeze. It is
a real hole in the guarantee but not a live drift source. Worth naming so nobody discovers
it by surprise during the lift.

**Fail-open is deliberate.** If `app_config` is unreachable the middleware treats the
system as OPEN (`write-freeze.ts:73-81`), and an unresolved active company is not frozen
(`write-freeze.ts:101`). The file is explicit that this is an operational convenience,
**not a security control** — the real protection is that staff were told to stop. Do not
reason about the freeze as if it were an access-control boundary.

### 3.3 What a normal staff user actually experiences — a real defect

The backend answers `503 { error: 'write_frozen', reason: '<the owner's message>' }`
(`write-freeze.ts:108-112`).

**On the SCM pages — SO, PO, DO — this works.** `frontend/src/vendor/scm/lib/authed-fetch.ts:543`
reads `j.reason`, and the owner's sentence reaches the operator:
*"Editing is paused while the AutoCount data migration is completed. Please do not create
or change orders — ask IT when you need something updated."*

**On anything using the core client, it does not.** `frontend/src/api/client.ts`
`humanHttpMessage` never reads `reason` — it looks at `error`, `message`, `detail` only
(`client.ts:200-217`). `write_frozen` is code-shaped, so it is looked up in
`ERROR_CODE_MESSAGES` (`client.ts:140-158`), **is not there**, falls back to `message`/`detail`
(**both absent — the backend named the field `reason`**), and lands on the status map:

> **503 → "The service is briefly unavailable. Please try again in a moment."** (`client.ts:232`)

That sentence actively invites the staff member to retry, tells them nothing true, and
routes a deliberate business decision into what reads like an outage. Two-line fix: add a
`write_frozen` entry to `ERROR_CODE_MESSAGES`, or have the backend also send the text as
`message`. **Recommendation: send it as BOTH `reason` and `message`** — one backend line,
fixes every client at once, and cannot drift.

**A latent trap in the same area, worth one sentence.** The SCM client retries
**mutations** on a 503 whose body matches `/briefly unavailable|warming up|try again in a
moment/i` (`authed-fetch.ts:269-273`). The current freeze message does not match, so
mutations are correctly not retried. But that message is operator-supplied via the
workflow's `MESSAGE` input — an operator who naturally writes "try again in a moment" into
a freeze notice would silently turn on 4x mutation retry. Harmless while frozen; it means
the freeze message text is load-bearing. Recommend a short comment on the workflow input.

### 3.4 Can the freeze be lifted in stages? — the central question

**Per company: YES, today, no code change.** Already the shipped design and already in
use. `parseFreezeValue` (`write-freeze.ts:51-57`) accepts `off` / `all` / a comma-separated
company id list, and the workflow takes `COMPANIES` as an input
(`backend/scripts/set-write-freeze.mjs`). Takes effect in ~30s (`FREEZE_TTL_MS = 30_000`).
This is exactly why 2990 has been trading normally throughout.

**Per permission: YES, but only as a blunt instrument.** `scm.admin` / `*` / `is_owner`
already bypass. So a pilot cohort can be created today by granting `scm.admin` — but that
grants **every** SCM write plus whatever else `scm.admin` implies, which is far more than
a pilot needs. Usable in a pinch; not something to design a staged go-live around.

**Per module: NO — not built. But the vocabulary already exists, and this is the
recommended addition.**

The freeze is all-or-nothing *within* a frozen company. However, `backend/src/scm/index.ts`
already mounts a per-area L2 guard on every sub-router — 73 `scmAreaGuard(...)` calls —
and its area keys map almost exactly onto the owner's criterion-1 document list:

| Owner's document | Existing L2 area key | Mount |
|---|---|---|
| Sales Order | `scm.sales.orders` | `scm/index.ts:266` |
| PO | `scm.procurement.po` | `scm/index.ts:254` |
| DO | `scm.sales.delivery` | `scm/index.ts:279` |
| GR (GRN) | `scm.procurement.grn` | `scm/index.ts:261` |
| PI | `scm.procurement.pi` | `scm/index.ts:263` |
| SI | `scm.sales.invoices` | `scm/index.ts:289` |

**Recommended change, small and well-bounded:** extend the stored value from a company
list to a company + area-exception list, so the freeze can be lifted one document type at
a time. Concretely:

- Store `1` (all of company 1 frozen, today's behaviour) or `1 - scm.sales.orders` /
  `1 - scm.sales.orders,scm.procurement.po` (company 1 frozen EXCEPT those areas).
- `parseFreezeValue` gains the exception list; the middleware needs the area for the
  current request. The cleanest wiring is for `scmAreaGuard` to stash its area key on the
  context and for the freeze check to move to just after it, or for the freeze middleware
  to resolve the area from the path prefix using the same table `index.ts` already
  declares.
- Keep every existing behaviour: parse must still accept `off`, `all` and a bare company
  list unchanged, so a value written today keeps meaning what it means.
- Extend `backend/tests/writeFreezeScope.test.ts` (it already exists and already pins
  `parseFreezeValue`), and add the exception syntax to `set-write-freeze.mjs`.

**Estimate: one focused PR.** One pure function, one middleware read, one workflow input,
one test file. No migration — `app_config.value` is already `text`.

**Recommendation on whether to build it.** Build it, because the sequence in §8 needs it:
criterion 1 must be validated by real staff performing real edits, and doing that on the
whole SCM surface at once is precisely the "数据就乱了" the owner is protecting against.
Lifting `scm.sales.orders` alone, for company 1, with the AutoCount sync watched
document-by-document, is the smallest honest test of criterion 1 that exists.

**If it is NOT built**, the fallback staged lift is: keep the freeze on, grant `scm.admin`
to two or three named pilot users, and have them do the criterion-1 validation. Cruder,
available today, and adequate — but it gives the pilot cohort far more authority than the
task needs, and it produces no reusable mechanism.

---

## 4. Is the write path trustworthy? — blast radius of the `APPLIED`-but-nothing-changed defect

**Symptom being reasoned about:** `backend/scripts/refresh-sofa-colours.mjs` printed
`APPLIED - stamped 146 sofa lines` on three separate runs while a read 29 seconds later
showed nothing had changed. **Root cause is owned by another agent and is not duplicated
here.** The only question answered here is whether the same defect can reach staff.

### 4.1 The answer: MOSTLY NOT SHARED — with seven specific exceptions

The framing in the task — "the API writes Drizzle via `getDb(env)` through Hyperdrive" —
**is not true of the documents in question.** But the corrected picture is not a clean
all-clear either, and the exception matters.

**The bulk of SCM writes share nothing with the script.** Measured across `backend/src/scm/`:
**456** PostgREST write calls across **79** route files taking `c.get('supabase')`, and
**0** files using Drizzle or `getDb()`.

| | The maintenance scripts | The SCM document API — the 456 |
|---|---|---|
| Library | `postgres` (postgres.js) | `@supabase/supabase-js` |
| Protocol | PostgreSQL wire protocol over TCP | **HTTPS to PostgREST** |
| Connection | Direct `DATABASE_URL`, `{ ssl:'require', prepare:false, max:1 }` | Stateless HTTPS request, service-role key |
| Hyperdrive / Drizzle | Not used | **Not used** |
| Client-side transaction | `sql.begin()` — the failure class lives here | **Does not exist** |

`backend/src/db/supabase.ts:1-16` states it outright: *"The rest of Houzs talks to Postgres
via Drizzle over Hyperdrive. The ported 2990's SCM routes talk to the SAME Supabase
database via its REST API (PostgREST) using supabase-js — one database, two access paths."*
SO header insert `mfg-sales-orders.ts:4945`, items insert `:5342`, line PATCH `:8299`, PO
client `mfg-purchase-orders.ts:68` — all PostgREST. For these, the family of defects the
symptom points at (a transaction never committed, a `sql.begin()` resolving before writes
flush, a `sql.end()` racing in-flight statements) **requires a client-held transaction and
connection, and PostgREST has neither.**

**But exactly one file in `src/scm/` uses `getSql()`** — `src/scm/lib/pg-supabase-transaction.ts`
— and **7 endpoints** call it via `runScmPgCommand`:

| Endpoint | Location | Why it matters |
|---|---|---|
| **SO cancel** | `mfg-sales-orders.ts:5764` | **Directly under ruling 5.3** (cancel divergence) |
| **`tbc-update`** | `mfg-sales-orders.ts:8712-8719` | **The staff-facing sofa fabric/colour fill-in** |
| `tbc-swap` | `mfg-sales-orders.ts:9170-9177` | same build path |
| `tbc-swap-sofa` | `mfg-sales-orders.ts:9971-9978` | same build path |
| PO amendment approve | `po-amendments.ts:413` | PO edit path |
| SO amendment approve | `so-amendments.ts:765` | SO edit path |
| Approve PO from SO amendment | `so-amendments.ts:886` | SO→PO edit path |

These share the script's **exact** mechanism: postgres.js `^3.4.9`, `sql.begin()`
(`pg-supabase-transaction.ts:454` vs `refresh-sofa-colours.mjs:161`), and `unsafe(text, values)`
(`:291` vs `:165`). Worse, `TBC_BUILD_SHARED_KEYS` (`mfg-sales-orders.ts:8493`) —
`fabricId, fabricCode, fabricLabel, colourId, colourLabel, colourHex, sofaLegHeight` — are
**the same keys the failing script stamps, written to the same jsonb column on the same
table** (`:8649-8663`). If the root cause is in postgres.js transaction handling, this
endpoint inherits it verbatim.

### 4.2 Why the API is still materially safer than the script, even on those seven

Verified, not assumed — and this is the part that makes the exposure manageable:

- **The API shim always appends `RETURNING`** (`pg-supabase-transaction.ts:240-242, :261, :265, :284`)
  and derives its count from `rows.length` (`:321`). The script has **no `RETURNING`** and
  reads success off the command tag (`refresh-sofa-colours.mjs:174`). The API is verifying
  what the script merely asserted.
- **Any statement error throws** (`:311`), aborting the whole `sql.begin()`; the catch at
  `:482-485` returns HTTP 500 *"The operation was rolled back."* **There is no path that
  reports success on a rolled-back command.** A non-2xx handler response also forces
  rollback (`:473`), and non-DB side effects are deferred until after commit
  (`deferScmAfterCommit`, `:390-393`, drained `:476-480`).
- The script's `wrote` counter is incremented **inside** the transaction (`:174`) and
  printed **after** (`:180`) with **no post-commit re-read** — structurally the shape that
  produces a false `APPLIED`.
- The retry wrapper never re-sends writes (`db/supabase.ts:31-37`): network throws on any
  method, 502/503/504 on **GET only**. *"A 5xx on a write is returned as-is so a possibly-
  applied mutation is never re-sent."*

### 4.3 Hyperdrive read caching — ruled out

Worth stating because it is the intuitive explanation and it is wrong:

- **For the script:** its write *and* the verifying read both ran from GitHub Actions over
  a direct `DATABASE_URL`. **Hyperdrive is not in that path at all**, so a stale Hyperdrive
  cache cannot explain the observed symptom.
- **For staff after the lift:** the SCM read path is the *same* PostgREST client as the
  write path (`c.get('supabase')`, e.g. GET at `mfg-sales-orders.ts:724`), bypassing
  Hyperdrive entirely. **A Hyperdrive read cache cannot make an SO or PO save read back
  blank on the SCM surface.** Hyperdrive serves only `env.DB` (reference data — lead
  buffers, brands, venues) and the non-SCM Drizzle routes.
- **Caveat, inferred:** `wrangler.toml` carries no `caching` block and states at `:113-115`
  that the Hyperdrive config lives in the Cloudflare console, outside the repo. Whether
  default query caching is enabled is a console check, not a repo fact.

**Relevant precedent, and it is reassuring.** This repo's one prior "saved but reads blank"
in the API path (`BUG-HISTORY.md:1257-1262` — showroom parking) was **a stale frontend
react-query cache, not a lost write**; the write had persisted, proven against live prod.
No BUG-HISTORY entry describes a script reporting a write count that did not land.

### 4.4 What this means for the assessment

The alarming reading — *"our writes silently do not persist, so nothing can be trusted"* —
**is not supported for the surface staff spend their day in.** SO creation, line editing,
header edits and PO raising all run on PostgREST, a different stack from the failing
script, with no Hyperdrive in either the read or the write path.

Two qualifications carry into the plan:

1. **The seven `runScmPgCommand` endpoints are unproven** until the script's root cause is
   pinned. Two of them — `tbc-update` and SO cancel — sit directly on the owner's critical
   path. **Recommendation: gate them behind one explicit test** (§8 stage 0, §9 U4): perform
   one `tbc-update` on a real SO and independently re-read `variants`. Because the API
   returns the `RETURNING` row and surfaces rollbacks as 500s, a genuine failure there
   should be *visible* rather than silent — so this test is cheap and conclusive.
2. **The audit and repair scripts are the untrustworthy layer**, and they are exactly what
   is being used to fix criteria 2 and 3. Every `APPLIED` line from a `.mjs` script is an
   unverified claim until a separate read confirms it. §8 sequences around this.

---

## 5. The four owner rulings, folded in

### 5.1 "不可以删只可以 cancel" — nothing is ever deleted

Audited across the six criterion-1 document types. The picture is better than the ruling
implies, with **one genuine violation**.

**Document-level DELETE endpoints:**

| Document | Endpoint | Guard | Verdict |
|---|---|---|---|
| SO | `mfgSalesOrders.delete('/:docNo')` (`mfg-sales-orders.ts:5832`) | **DRAFT only.** Non-draft returns 409 `so_not_draft`: *"Only a draft can be discarded. A confirmed order must be cancelled, not deleted."* Plus CAS version check and edit-lease check | **Compliant in spirit.** A draft has never been a real document |
| PO | `mfgPurchaseOrders.delete('/:id')` (`mfg-purchase-orders.ts:4184`) | **CANCELLED only** — 409 otherwise: *"Only CANCELLED POs can be deleted. Use Cancel first."* Then hard-deletes, items cascading via FK | **VIOLATES the ruling.** Cancel-then-purge is still a purge |
| DO | none | — | Compliant |
| GRN | none | — | Compliant |
| SI | none | — | Compliant |
| PI | none | — | Compliant |

The PO case is the one to fix, and the code itself explains why it matters — the audit
entry is described in-file as *"the ONLY remaining evidence that the PO existed"*
(`mfg-purchase-orders.ts:4219-4223`). Under live sync that is worse than a local data-loss
question: if the PO had already synced, AutoCount still holds it, the ERP no longer knows
it existed, and **no cancel can ever be pushed** to reconcile the two.
**Recommendation: remove the PO document DELETE endpoint.** Cancel already exists and
already does the business job. This is a deletion of code, not a new feature.

**Two other delete classes, both of which should NOT be removed:**

- **Create-rollback deletes** (`mfg-sales-orders.ts:5343`, `mfg-purchase-orders.ts:1342`
  and `:2351`, `delivery-orders-mfg.ts:3377`, `:3398-3399`, `:3894`, `:3911-3912`). These
  undo a header whose item-insert just failed, milliseconds later. Because supabase-js
  has **no transaction**, these compensating deletes are the only thing standing between a
  failed create and a permanent headerless orphan. Removing them would create the very
  garbage the ruling is trying to prevent. They leave numbering gaps, which
  `nextMonthlyDocNo` explicitly tolerates by design (§6.4). **Recommendation: keep, and
  document them as compensation rather than deletion.**
- **Line and child deletes** — SO items (`:8350`), SO payments (`:10866`), PO items
  (`:3117`), PO allocations (`:3386`), DO items (`:4775`), DO payments (`:4925`), and the
  equivalents on GRN (`grns.ts:3189`), SI (`sales-invoices.ts:1794`, `:2012`), PI
  (`purchase-invoices.ts:2198`), DR (`delivery-returns.ts:1488`), PR
  (`purchase-returns.ts:1339`). Removing a line while editing a document is ordinary ERP
  behaviour and is not what the ruling is about. **But under live sync it becomes a
  divergence risk** — the ERP drops the line, AutoCount keeps it — and that is line
  identity, which belongs to criterion 1. **Handed to `docs/autocount-sync-coverage.md`,
  not resolved here.**

### 5.2 "暂时只可以在 erp 改" — the ERP is the only editing surface

**This is a genuine and substantial simplification, and it should be stated as one.** It
removes bidirectional conflict resolution from v1 entirely. There is no merge policy to
design, no last-writer-wins rule to argue about, no clock-skew question. Sync becomes
one-directional: ERP is the writer, AutoCount is the follower. Every "who wins on a
conflict" question in the original brief is answered by "the conflict cannot arise."

**The replacement risk it creates:** staff editing in AutoCount out of old habit, and
nobody noticing. Under one-directional sync an AutoCount-side edit is not merged and not
rejected — it is **silently overwritten on the next ERP push, or silently retained forever
if that document never syncs again.** Either way it is invisible.

**This is an owner decision and is recorded as one:** lock it down by AutoCount permission,
or merely detect it. Both are viable.

- **Recommendation: detect first, lock second.** A read-only comparison of AutoCount's
  document `LastModified` against the ERP's last push timestamp finds every out-of-band
  edit without touching anybody's AutoCount access on day one. Locking permissions before
  go-live risks blocking a legitimate accounting workflow nobody remembered to mention,
  during the exact week when the ERP is least proven. Detect during the pilot, lock once
  the pilot shows nobody needs the access.

### 5.3 "一边取消一边没取消 ... 那要解决" — cancel divergence

Now an explicit go-live requirement. Acceptance test, per the owner's own outstanding rule:
**the outstanding set — not converted to DO and not converted to IV — must compute
IDENTICALLY on both sides after a cancel.**

Two things this assessment can contribute:

- The ERP already carries that exact rule. The cutover data was built on it:
  `ac-outstanding-so.json.gz` is defined as *outstanding = 还没转 DO* (13,703 rows), and
  `ac-so-iv-excluded.json.gz` (129 rows) carries the SOs invoiced without a DO. So the
  predicate is agreed and already implemented on the import side — the acceptance test has
  a definition to reuse, not one to invent.
- **The PO hard-delete in §5.1 is a direct cancel-divergence generator** and should be
  fixed as part of this requirement, not separately. A purged PO cannot be cancelled on
  the AutoCount side because the ERP retains nothing to push.

Measurement belongs to `docs/autocount-sync-coverage.md`.

### 5.4 "zerotier 只能保证不断" — transport

The available mitigation is keeping the link up. Current transport: ZeroTier to
`10.147.17.100,55500`.

**Treat "the link stays up" as the happy path and build for its failure anyway** — on the
single ground the coordinator named, which is the correct one: **a save that succeeds in
the ERP while its sync is silently lost must be impossible.** A dropped link is a
when, not an if, and the failure is silent by default.

Minimum bar, none of which exists today:

| Requirement | State |
|---|---|
| Durable queue — the sync intent is persisted in the ERP's own database **in the same operation that commits the document**, so it survives a Worker restart, a link drop and a redeploy | **Not built** |
| Retry with backoff, and an explicit terminal state (DLQ) rather than infinite silent retry | **Not built** |
| Loud alarm on queue depth / age — a stuck queue must page a human, not accumulate quietly | **Not built** |
| Operator-visible sync state per document — "synced / pending / failed" on the document itself, so staff can see the truth without asking IT | **Not built** |

The last row is the one most often skipped and the one staff will feel most. **Recommendation:**
a `sync_status` + `sync_error` + `synced_at` triple on each document header, surfaced as a
badge on the document. It makes the whole class of failure visible to the people best
placed to notice it, and it costs one migration.

Cloudflare Queues are already in use in this codebase (`SCAN_QUEUE`, consumed by `queue()`
at `index.ts:741`), so the queue primitive and its consumer pattern are established — this
is a second consumer, not new infrastructure. Note the freeze does **not** cover queue
consumers (§3.2), which is fine here but must be remembered when the sync queue exists:
a frozen company's documents must not sync out of a queue that ignores the freeze.

---

## 6. What would disrupt daily operations — the risk register

The owner's real fear. Each risk, and whether a guard exists **today**.

### 6.1 A document that reprices itself on first edit

**Guard: PARTIAL. This is the least-resolved item in this section.**

The SO edit path deliberately re-derives price from the catalog: *"The new line reprices
from the catalog (`sell_price_sen`) with every option"* (`mfg-sales-orders.ts:8724`), and
the sofa rebuild path performs an *"Authoritative reprice — the SAME inputs as SO create /
item PATCH"* (`:9420`). That is correct and intentional for a document being built now.

**The risk is the 13,703 imported AutoCount SOs**, whose prices are historical and whose
catalog prices today may differ. I found **no marker distinguishing an imported document
from a natively created one** in the SCM route code — greps for `is_migrated`,
`migrated_from`, `import_run` returned nothing in `backend/src/scm/`. The cutover ledger
identifies migrated rows by SQL predicate rather than by a column the application reads.

So on the evidence I have: **an imported SO opened and edited by staff may reprice its
untouched lines to today's catalog price, and there is no application-level guard that
stops it.** I am labelling this **INFERRED, NOT VERIFIED** — proving it requires either
tracing every write in the ~10,400-line SO router or exercising an edit against a real
imported SO, and the freeze prevented the latter. It is listed as a blocker because the
consequence (silently restating historical customer prices) is severe and the cost of
checking is low.

**Recommendation:** before the freeze lifts, take one imported SO on staging, edit an
unrelated field, and diff every line's price. One test, and it either clears the risk or
finds the most damaging bug on this list.

### 6.2 A stock movement that double-deducts

**Guard: EXISTS, but it is weaker than the code claims.**

`deductInventoryForDo` opens with a real existence check (`delivery-orders-mfg.ts:1231-1238`):
count `inventory_movements` where `source_doc_type='DO'` AND `source_doc_id=<id>` AND
`movement_type='OUT'`; if greater than zero, no-op. Verified present and correct.

**But the comment at `delivery-orders-mfg.ts:3416` claims "the existence check + UNIQUE
index mean this never double-deducts", and the UNIQUE index does not exist.** Migration
0230 enumerates the indexes on `scm.inventory_movements` in its own comment
(`0230_scm_ship_commitment_binding.sql:130-134`): `(warehouse_id, product_code)`,
`(source_doc_type, source_doc_id)`, `(created_at)`, `(company_id)` — and adds
`idx_inv_mov_batch_out`. **None is UNIQUE.** There is no `CREATE TABLE inventory_movements`
and no `CREATE UNIQUE INDEX` on it anywhere in `backend/src/db/`.

So the protection is a **read-then-write existence check with no unique constraint behind
it** — a textbook TOCTOU window. Two concurrent confirms of the same DO, or a retry racing
its original, can both read zero and both insert. Narrow, but real, and it has a
production precedent: SO-2606-019 was double-shipped by two DOs and stock was
double-deducted.

Mitigating: idempotency keys are sent by the create surfaces including
`DeliveryOrderNewV2.tsx` and `MobileConvertWizard.tsx`, and the middleware is
principal-and-company scoped (`index.ts:306`) — **but it is opt-in and a no-op unless the
client sends a key** (`index.ts:302-305`), so it protects the surfaces that opted in, not
the mechanism.

**Recommendation:** add the partial unique index the comment already assumes —
`CREATE UNIQUE INDEX ... ON scm.inventory_movements (source_doc_type, source_doc_id, movement_type) WHERE source_doc_type = 'DO' AND movement_type = 'OUT'`, subject to checking it against live data first for existing duplicates. One migration, and it converts a race into a database-enforced impossibility. **Verify against production before writing it** — SO-2606-019's duplicate movements may still be present and would block index creation, which would itself be useful information.

### 6.3 A save that silently does not persist

**Guard: STRONG on 456 of the SCM writes, UNPROVEN on 7 (§4).**

The PostgREST path verifies writes by returned row and cannot lose a client-side
transaction because it has none. The `runScmPgCommand` seven — including `tbc-update` and
SO cancel — share the failing script's driver and transaction wrapper, but append
`RETURNING` and surface rollbacks as HTTP 500, so a failure there should be loud rather
than silent. The remaining exposures:

- **The script path** — demonstrated, three times. Every repair script's `APPLIED` output
  must be confirmed by an independent read. This is a live constraint on criteria 2 and 3.
- **The stale-read class**, which is not the same bug but presents identically to a user.
  There is precedent: a showroom-parking save persisted correctly while the Members panel
  showed stale data because a 300s `staleTime` was not invalidated after the PATCH. The
  established remedy in this codebase is the `invalidateCache` / `verifiedSave` pattern.
  **Recommendation:** during the pilot, treat every "it didn't save" report as a
  cache-invalidation question first, and check the database before believing the UI.

### 6.4 A number series that collides with AutoCount's

**Guard: EXISTS ERP-side. DOES NOT EXIST cross-system.**

ERP-side the design is sound and hard-won (`backend/src/scm/lib/doc-no.ts`). Format
`<PREFIX>-YYMM-NNN`; `nextMonthlyDocNo` is `max(suffix)+1`, never `count+1` — the header
records that `count+1` took down POS order creation on 2026-06-12 after a cleanup deleted
`SO-2606-002..007`. `fetchMonthlyDocNos` pages the full month because PostgREST silently
caps at 1000 rows, which would otherwise re-mint a live number deterministically for the
rest of the month. Per-company prefixes are contractual: Houzs bare `SI-2607-001`, others
`2990-SI-2607-001`. A unique doc-no index plus `insertWithDocNoRetry` catches races.

**Every one of those guarantees is computed from the ERP's own tables.** Nothing consults
AutoCount's running numbers. The proven write-back pushed `SO-2608-001` and `SO-2608-002`
into live `AED_HOUZS` — numbers the ERP minted.

Under ruling 5.2 the risk mostly evaporates: if nobody creates documents in AutoCount, the
two series cannot race. The residual risks are (a) AutoCount's own next-number counter
drifting from what the ERP has pushed, so a later AutoCount-side document — including one
created by accounting for a legitimate reason — collides; and (b) nothing detecting it.

**Recommendation:** a read-only cross-system doc-number comparison, run before the freeze
lifts and periodically after, following the established `check-soak-gate.mjs` pattern
(workflow_dispatch, read-only, own concurrency group, exit 0 for every legitimate answer).
Cheap, and it turns an invisible collision into an annotation.

### 6.5 Summary

| Risk | Guard today | Residual |
|---|---|---|
| Reprice on first edit of an imported document | **None found** (inferred) | **High** — untested, severe if real |
| Double-deduct on DO | Existence check; **no unique index** despite the comment | **Low-moderate** — TOCTOU race, with production precedent |
| Save silently not persisting (the 456 PostgREST writes) | Strong — returned-row verification, no client transaction, no Hyperdrive | **Low** |
| Save silently not persisting (the 7 `runScmPgCommand` endpoints) | `RETURNING` + rollback-as-500, but same driver and `sql.begin()` as the failing script | **Moderate, unproven** — one test settles it |
| Save silently not persisting (scripts) | **None** — demonstrated three times | **High**, but confined to IT-run repairs |
| Doc-number collision with AutoCount | ERP-side only | **Low** under ruling 5.2, **undetected** either way |
| Sync silently lost on link drop | **None** — no queue, no retry, no alarm | **High** |

---

## 7. The tables

### 7.1 BLOCKERS — must be true before staff touch the system

Every row maps to one of the owner's three criteria, or is justified as a prerequisite.

| # | Blocker | Criterion | State | Evidence | Recommendation |
|---|---|---|---|---|---|
| B1 | **Sofa physical stock was never imported** — 0 lots carry a `batch_no` | 3a | OPEN | Ledger §5 item 14. `import-ac-sofa-stock.mjs` DRY-RUN only: 97 lots / 97 units / 43 batches, 45 builds; drop = 4 over-balance, 9 placeholder | Apply the import. It is written and dry-run clean. Confirm the result with an independent read, not the script's own output (§4.3) |
| B2 | **All 13,881 imported SO lines have `warehouse_id = NULL`** → every imported line permanently PENDING; sofa `findCoveringBatch` returns null on sight | 3b (and 3a) | OPEN | Ledger §5 item 13, measured on prod 2026-08-10. `import-ac-outstanding-so.mjs` computes `warehouseId` in three places but `ICOLS:467` omits the column | Run `backfill-so-line-warehouse.mjs` with `GROUP=all` (13,881 lines), not the 981-sofa default. This is the most likely single cause of criterion 3b |
| B3 | **No ERP-callable AutoCount sync service** — the write-back is a hand-run program, not a service | 1 | OPEN | Two orders written into live `AED_HOUZS` by hand. No ERP caller, no queue, no retry, no alarm | See `docs/autocount-sync-coverage.md`. Minimum bar in §5.4 |
| B4 | **No durable queue / retry / alarm** — an ERP save can succeed while its sync is silently lost | 1 (ruling 5.4) | OPEN | §5.4. `SCAN_QUEUE` proves the primitive exists; there is no sync queue | Persist the sync intent in the same operation that commits the document; add per-document `sync_status` |
| B5 | **Company 1 field alignment: 8 short POs, 16 variant-value differences, 14 children with no variants, 181 null `so_item_id`, 1 dangling FK** | 2 | OPEN | Run 31412356560. Company 2 clean (31412605952) | Third agent re-measuring on the field; the 8 short POs need adjudication |
| B6 | **Cancel divergence unproven** — no test that the outstanding set matches on both sides after a cancel | 1 (ruling 5.3) | OPEN | §5.3 | Reuse the existing outstanding predicate (not-DO, not-IV); the definition already exists in the import data |
| B7 | **PO document hard-delete destroys the only record a cancel could be pushed from** | 1 (ruling 5.1) | OPEN | `mfg-purchase-orders.ts:4184`, `:4219-4223` | Remove the endpoint. Cancel already does the business job |
| B8 | **Imported documents may reprice on first edit** | prerequisite — protects 2 and the customer | **UNVERIFIED, high consequence** | §6.1. No migrated-document marker found in `backend/src/scm/` | One staging test on one imported SO before the freeze lifts. Cheapest high-value check on this list |
| B9 | **Write freeze is on and all-or-nothing within company 1** — no staff member can save anything, so nothing above can be validated by a human | prerequisite to all three | OPEN, by owner's instruction | `scm.app_config['scm.write_freeze'] = '1'`, ledger §5 item 12 | Do **not** lift globally. Build the per-module lift (§3.4) and lift `scm.sales.orders` first |
| B10 | **7 endpoints share the failing script's driver, `sql.begin()` and `unsafe()`** — including `tbc-update` (the sofa colour fill-in, same jsonb keys and table as the script) and **SO cancel** | prerequisite to 1, 2 and ruling 5.3 | **UNPROVEN** | §4.1. `pg-supabase-transaction.ts` is the only `getSql()` user in `src/scm/`; call sites at `mfg-sales-orders.ts:5764, :8712, :9170, :9971`, `po-amendments.ts:413`, `so-amendments.ts:765, :886` | One `tbc-update` on a real SO, then an independent re-read of `variants`. The API appends `RETURNING` and turns rollbacks into 500s, so this test is conclusive either way |

### 7.2 SHOULD FIX FIRST — real, not blocking

| # | Item | Why it matters | Evidence | Recommendation |
|---|---|---|---|---|
| S1 | Freeze message never reaches non-SCM surfaces — staff see "briefly unavailable. Please try again in a moment." | Turns a business decision into an apparent outage and invites retry | `client.ts:200-232`; backend sends `reason`, client reads `message` | Send the text as **both** `reason` and `message`. One backend line |
| S2 | No unique index behind the DO double-deduct check, despite the comment claiming one | TOCTOU race on the money-critical path, with production precedent | `delivery-orders-mfg.ts:3416` vs `0230_...sql:130-134` | Add the partial unique index; check live data for existing duplicates first |
| S3 | No cross-system doc-number collision detector | ERP mints from its own tables only | §6.4 | Read-only workflow on the `check-soak-gate.mjs` pattern |
| S4 | AutoCount-side edits undetectable under one-directional sync | Ruling 5.2's replacement risk | §5.2 | Detect via `LastModified` comparison first; lock permissions after the pilot |
| S5 | `linked_ac_docno` on `scm.purchase_orders` has no migration — created by an inline `ALTER TABLE` in a script | A rebuilt environment will not have the column | Ledger §5 item 2; `import-ac-outstanding-po.mjs:314` | One migration to close it |
| S6 | 138 zero-cost lots / 317 units; 620 lines with no cost | Margin reads as pure profit on those lines | Ledger §5 items 4 and 7 | `backfill-zero-cost-lots.mjs` exists and has **never been run** |
| S7 | Queue consumer and cron bypass the write freeze | Correct today (enqueue is itself frozen), wrong once a sync queue exists | §3.2, `index.ts:741` | Make the future sync consumer freeze-aware |
| S8 | W7 SO-linked PO import incomplete — ~181 of 234 written | Missing links weaken criterion 2 | Ledger §5 item 1; run 31356530158 cancelled mid-log | Re-run; the script is idempotent |
| S9 | 25 POs fully received but lines still PENDING | Status misalignment feeding criterion 3b | Ledger §5 item 8, run 31356787188 §1 | Run a recompute |

### 7.3 CAN WAIT

| # | Item | Why it can wait |
|---|---|---|
| C1 | 39 AutoCount photos not yet attached in ERP | Cosmetic; 18 are on delivered orders and correctly excluded by the DO rule. Ledger §5 item 5b |
| C2 | 22 venue values not in the dropdown; 3 SP lines missing sizes | Reporting polish, not a document-correctness or stock issue. Ledger §5 item 10 |
| C3 | 45 negative stock deltas (report-only) | Owner decision, and small. Ledger §5 item 3 |
| C4 | `AMN-SOFA PILLOW` 205 units excluded by the `/SOFA/i` filter | Real but bounded; a delta re-run fixes it once the filter narrows. Ledger §5 item 16 |
| C5 | 29 sofa builds with no real receipt cost (AutoCount sofa POs carry NULL unit price) | Do not guess prices. Leave at 0 and let the zero-cost backfill cover what it can. Ledger §5 item 15 |
| C6 | `align-open-skus` / `align-rebind-unlinked` never applied | Ledger §5 item 9 explicitly warns not to assume these were superseded — but neither blocks the three criteria |
| C7 | Freeze-message wording can accidentally trigger mutation retry | Latent and harmless today; a comment on the workflow input is enough. §3.3 |

---

## 8. The sequenced go-live plan

The ordering is forced by three facts: **criterion 3 is data and can proceed under the
freeze; criterion 1 needs humans and therefore needs the freeze lifted; and the scripts
doing the criterion-3 work cannot be trusted to report their own success (§4.3).**

**Stage 0 — clear the ground. Freeze stays ON. No staff impact.**
1. B8: test one imported SO on staging for repricing. **Do this first** — it is cheap and
   it can invalidate the plan.
2. B10: one `tbc-update` on a real SO, then an independent re-read of `variants`. Settles
   whether the seven shared-mechanism endpoints are safe. Pair it with U2 (does the
   `inventory_movements` unique index exist) — both are single read-only queries.
3. S1: make the freeze message reach every surface. Small, and it improves every
   subsequent stage.
4. B7: remove the PO hard-delete.
5. S2: check production for duplicate DO OUT movements, then add the unique index.

**Stage 1 — criterion 3, the data. Freeze stays ON. No staff impact.**
6. B2: backfill `warehouse_id` on all 13,881 imported SO lines.
7. B1: apply the sofa stock import.
8. S8, S9, S6: finish the PO link import, recompute the 25 stuck POs, backfill zero-cost lots.
9. **Re-read every result independently.** Not the scripts' own `APPLIED` lines.
10. Re-run the reconciliation for `docs/stock-reconciliation.md`. **Criterion 3 must go
    PASS here.** If it does not, stop — nothing downstream is meaningful.

**Stage 2 — criterion 2, the fields. Freeze stays ON.**
11. B5: adjudicate the 8 short POs, the 16 variant differences, the 14 no-variant children,
    the 181 null `so_item_id`, the 1 dangling FK.
12. **Criterion 2 must go PASS.**

**Stage 3 — build the sync. Freeze stays ON.**
13. B3 + B4: package the write-back as an ERP-callable service, with the durable queue,
    retry, alarm and per-document `sync_status` from §5.4.
14. S3: doc-number collision detector. S4: AutoCount-side edit detector.
15. Exercise every document x operation on staging against a non-production AutoCount book.

**Stage 4 — the staged freeze lift. THIS is where the freeze moves, and not before.**
16. Build the per-module lift (§3.4). One PR.
17. Lift **`scm.sales.orders` for company 1 only.** Everything else stays frozen; 2990 is
    unaffected throughout.
18. A named pilot cohort raises and edits real SOs. Watch each one reach AutoCount.
    Validate B6 (cancel divergence) with a real cancel on a real document — noting that SO
    cancel is one of the seven B10 endpoints, so this doubles as its production proof.
19. Lift the remaining areas **one at a time**, in the order the business actually needs
    them — PO, then GRN, then DO, then PI, then SI — each with the same watch.
20. Lift fully (`value = 'off'`) only after every area has run clean.

**Why the freeze lifts last and in pieces.** It is the only irreversible-feeling step: once
staff are editing, the drift the owner fears has started, and rolling back means
reconciling human work rather than re-running a script. Everything that can be validated
without a human should be validated first, and the first human validation should be the
smallest one that can prove criterion 1.

---

## 9. What I could NOT determine, and what it would take

Listed honestly. Each has a specific, cheap next step; none needs the owner.

| # | Not determined | Why | What would settle it |
|---|---|---|---|
| U1 | **Whether an imported SO reprices on edit** (B8) | Freeze on; verifying by code would mean tracing every write in a ~10,400-line router | One staging edit on one imported SO, diffing every line price. Highest value per minute on this list |
| U2 | **Whether a UNIQUE index on `scm.inventory_movements` exists in the live database** | It is absent from the migration tree and migration 0230 says there was none, but the table predates these migrations (it came from the 2990 schema dump), so it could exist out-of-band | One read-only query: `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='scm' AND tablename='inventory_movements'`. A read-only workflow on the `check-soak-gate.mjs` pattern |
| U3 | **How many staff actually hold `scm.admin` or `is_owner`** — i.e. how many people the freeze does not currently stop | Role assignment lives in the database, not in code | One read-only query over the role/permission join. Worth knowing before claiming the freeze is holding |
| U4 | **Whether the 7 `runScmPgCommand` endpoints persist reliably** (B10) — they share the failing script's driver, `sql.begin()` and `unsafe()`, and `tbc-update` writes the same jsonb keys on the same table | Freeze on, and I was scoped read-only. The root cause itself is owned by another agent | One `tbc-update` on a real SO, then an independent re-read of `variants`. Conclusive because the API appends `RETURNING` and turns a rollback into a 500 — a genuine failure should be loud |
| U4b | **Whether Hyperdrive query caching is enabled** | The Hyperdrive config lives in the Cloudflare console, not in `wrangler.toml` (`:113-115`), and carries no `caching` block in-repo | A console check. Low priority — §4.3 shows the SCM read and write paths both bypass Hyperdrive, so it cannot affect SO/PO save-then-read |
| U5 | **Whether DRAFT SOs sync to AutoCount** — decides whether the draft-only SO delete (§5.1) is safe or orphan-producing | Sync is not built, so the question has no answer yet | A design decision for `docs/autocount-sync-coverage.md`. **Recommendation: drafts must not sync.** Then the draft delete is unambiguously safe |
| U6 | **The true count of criterion-2 field defects on the field**, as opposed to in the audit | The current audit keys on a stale `SOFA UNPARSED` remark; a third agent is re-measuring | That agent's re-measure |
| U7 | **Whether the 181 null `so_item_id` rows are a data gap or a schema-normal state** | Not investigated here; it belongs to criterion 2 | The criterion-2 adjudication. Flagged because 181 is large enough to change the verdict either way |

---

## 10. Lessons already visible

- **A code comment asserting a database guarantee is not evidence.** The double-deduct
  comment claimed a UNIQUE index that does not exist in the migration tree, and the
  contradiction was found in another migration's own comment. Check the schema, not the
  prose. This is the same lesson `system-foundation-coe.md` recorded about verifying
  schema claims against the live DB rather than migration files — here it recurred in the
  opposite direction, and the migration tree was the thing that told the truth.
- **A script's success output is a claim, not a result.** Three `APPLIED` lines described
  work that had not happened. Every repair in stages 1 and 2 must be confirmed by an
  independent read. The structural difference is one word: the API appends `RETURNING` and
  counts rows; the script reads a command tag and never re-checks.
- **"Two different stacks" was nearly recorded as "no shared mechanism", and it was wrong.**
  The first pass of this document concluded the API and the scripts shared nothing. 456 of
  457 SCM write paths do share nothing — but the 457th is a `getSql()` helper behind seven
  endpoints, two of them on the critical path. A ratio that good is exactly what makes the
  exception easy to miss; the count had to be taken before the claim was safe to make.
- **Naming a response field `reason` when every client reads `message` costs the whole
  message.** The owner's carefully written freeze notice never reached anyone outside the
  SCM pages.
- **The per-company freeze was the right design and it paid for itself.** 2990 has traded
  normally throughout a cutover that would otherwise have stopped a business with no
  reason to stop. The per-module extension is the same idea applied one level down, and it
  is what makes a safe staged lift possible.

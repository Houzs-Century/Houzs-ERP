> # ⚠ READ BEFORE FRIDAY — the runbook was verified against the code 2026-08-13
>
> Twenty-one problems were found in §1 (the Friday execution runbook) by reading
> the source. **Four would change what happens to the live AED_HOUZS book.** Do
> not follow §1 as written until they are settled.
>
> ### The four that touch the live book
>
> **A. Step 6's unblock condition for the convert push is the wrong one, and the
> real risk is a daily occurrence.** The step says do not enable convert until
> D14 is fixed because "`enqueueConvert` sends no `DtlKeys`". It sends them —
> `autocount-outbox.ts:687`, `...(source.keys ? { DtlKeys: source.keys } : {})`,
> with a refusal when a partial transfer's source lines lack keys. What the code
> says is NOT covered (`:727-731`, verbatim): **partial QUANTITY on a line.** The
> SDK primitive takes line keys, not quantities, so *a DO shipping 2 of a 5-unit
> line still produces an AutoCount DO of 5 on that line.* Enable convert on the
> stated condition and every partial delivery moves stock in AutoCount that did
> not move in the ERP.
>
> **B. Step 3's premise is false, so the runbook's two-gate safety margin is one
> gate.** It says `AC_SYNC_URL` is "commented at line 34" and sends IT to build a
> tunnel. `wrangler.toml:42` has it SET and uncommented since 2026-08-11, on a
> tunnel that already answered. §5 gate 3 therefore reports HOLDING while it is
> OPEN — and the only remaining gate is the DB flag that Step 4 turns on.
>
> **C. Step 6's per-stage risk is understated in the unsafe direction.** §8 says
> `enqueueEdit` is imported "by no other route file" than SO and PO. It is
> imported by six more: `sales-invoices.ts`, `purchase-invoices.ts`,
> `delivery-orders-mfg.ts`, `grns.ts`, `so-amendments.ts`, `po-amendments.ts`;
> `enqueueCancel` by SI and PI. Opening `scm.sales.delivery` at stage 4 enables
> DO **edit** into the live book, not just the convert.
>
> **D. Skipping `AC_SYNC_KEY` dead-letters everything on attempt 1.** The URL
> alone passes the drain gate (`acServiceConfig` returns `key: null`), the header
> is omitted, the service answers 401, and 401 is NOT retryable
> (`retryable = status >= 500`) — so `dispatchOne` marks `failed` immediately,
> with no retry and only a `console.error` as the signal. The step exists
> (`wrangler secret put AC_SYNC_KEY`) but is buried inside Step 3, which problem
> B makes look already-done.
>
> ### Verifications that do not verify what they claim
>
> - **Step 1** accepts `/health` as proof of the swap. `/health` answers from
>   CONSTANTS — `deploy-on-host.ps1` records that exact failure on 2026-08-12 in
>   its section 3 and section 7 comments. (This cited `:215-222` until
>   2026-08-16, when the rewrite moved the text; grep for
>   `answers from CONSTANTS` rather than trusting a line number here again.)
>   **Half of this is fixed as of 2026-08-15**: `/health` now also
>   returns `builtAt` (the assembly's own file timestamp) and `mvid` (unique per
>   compilation), so it CAN prove a new binary was swapped in — compare `builtAt`
>   against `git log -1 --date=short -- backend/scripts/autocount-service/AcSyncService.cs`.
>   It still cannot prove a real DB connection; for that the probe is
>   `POST /ensure-masters` with empty arrays, and the runbook does not include it. It also omits two preconditions the script refuses
>   without: `ac-svc-key.txt` must exist, `ac-svc-port.txt` must read 8900.
> - **Step 3's verification** (`GET /health` "from a Worker") cannot be executed:
>   no Worker code path calls `/health` — `AC_ROUTE` has no health op, and
>   `callAcService` has two callers, both inside the drain. A bare curl without
>   `X-API-KEY` returns 401/503.
> - **Step 3's rollback** ("re-comment the URL — a complete stop") stops the
>   push, not the queue: `enqueueAcOp` never reads `AC_SYNC_URL`. Rows accumulate
>   and flush on restore, 20 at a time, unreviewed.
> - **Step 4's verification** ("outbox count still 0") is the repo's own
>   "check that answers a different question": zero is equally the answer if the
>   UPDATE matched nothing or the value was mistyped — `readWritebackScope`
>   resolves anything malformed to `off`, silently. Related: Step 4 says the flag
>   uses "the same grammar as the freeze", but an area clause is REFUSED
>   (`autocount-writeback-flag.ts:64-81`) precisely because pasting the freeze
>   value into the adjacent key is the anticipated mistake.
> - **Step 6's acceptance query** cites `AcSyncService.cs:403`, which is
>   `doc.Ref = ...`. The predicate is at `:431-433`, is per-document, and no
>   script implements the whole-book test the step describes.
>
> ### Unresolved contradiction inside this document
>
> Step 2 says checks 4.1-4.5 "have **never passed**"; §8 says "**five cells are
> PROVEN as of 2026-08-12**" with document numbers. Both cannot be true, and it
> decides whether Step 2 is an hour of work or already done. Per this repo's own
> rule — *a contradiction is a finding, do not bridge it* — settle it before
> Friday by reading `C:Tempac-sync-service.log` for `ZZERP-0001`, or by
> re-running the five checks.
>
> ### Two things the runbook says do not exist, which do
>
> `.github/workflows/autocount-outbox-health.yml` reports status counts, oldest
> pending age and every failed row's `last_error` — §4.2 says no such monitor
> exists. It is dispatch-only, so the ALARM gap is real; the "nothing exists"
> claim is not. And ~407 Houzs SOs / ~322 POs have incomplete line identity, so
> they will save in the ERP and silently never reach AutoCount (`skipped`,
> "refused, nothing sent") — no step mentions this population.

# The AutoCount to ERP migration: the record

**Status at 2026-08-11: PAUSED. Staff continue on AutoCount. Work resumes Friday.**

Owner's call, 2026-08-11: *"不行了，让他们继续用 autocount 先，我们星期五再继续做."* and
*"你把这整个 migrate 的过程记录下来 —— 怎么做，遇到什么问题，该做什么等等，到时我们统一去做星期五."*

So this file is two things at once. It is the **history** — what was done, how it was proved,
what broke. And it is the **instruction** — a numbered runbook someone follows on Friday, in
order, without this conversation. The runbook is section 1, deliberately near the front.

Written for a person who was not here. Every number below came from a named workflow run, a
production read, or a file in this repository. Re-run the check rather than trusting the number;
a figure in a document ages, a workflow does not.

## Contents

- [0. Where this stands — the owner's three criteria](#0-where-this-stands--the-owners-three-criteria)
- [1. The Friday execution runbook](#1-the-friday-execution-runbook)
- [2. The traps](#2-the-traps)
- [3. The rules this migration runs under](#3-the-rules-this-migration-runs-under)
- [4. The pipeline, end to end](#4-the-pipeline-end-to-end)
- [5. The gates — what is holding, verified 2026-08-11](#5-the-gates--what-is-holding-verified-2026-08-11)
- [6. The office host, exactly as it stands right now](#6-the-office-host-exactly-as-it-stands-right-now)
- [7. Verification — what has and has not happened](#7-verification--what-has-and-has-not-happened)
- [8. Coverage — six documents by four operations](#8-coverage--six-documents-by-four-operations)
- [9. The defects this migration found](#9-the-defects-this-migration-found)
  - [9.1 Is the migrated data identical to AutoCount? No — and here is the list](#91-is-the-migrated-data-identical-to-autocount-no--and-here-is-the-list)
- [10. What was migrated, and from which AutoCount column](#10-what-was-migrated-and-from-which-autocount-column)
- [11. Costing](#11-costing)
- [12. What is left — owner, IT, code](#12-what-is-left--owner-it-code)
- [13. Companion documents](#13-companion-documents)

---

## 0. Where this stands — the owner's three criteria

He set these himself and nothing ships until all three pass. His words, then the verdict, then
the number that carries it.

> 1. 基础单据同步：我们的 Sales Order、PO、DO、GR、PI、SI 等所有单据，无论是我打开后进行
>    Convert 还是 Edit 等操作，全部都要能 Sync 到 AutoCount。这是最基础的。
> 2. 字段与关系对齐：我们的 Sales Order、PO 等单据的 Compartment 和 variant 全部都一定要对齐，
>    它们之间的对应关系也必须对齐。
> 3. 库存与状态核对：(a) Stock Balance Record 必须对齐。(b) 同时检查 Remark 2（他的 stocks
>    Status）跟 ERP stocks Status 是否对齐；没对齐就要查明原因，因为 by right 它们应该对齐。
>
> 把这些 Bug 全部解决完之后，我们才能上线。

He later narrowed the gate: **SO + PO, create + edit is enough to open**; DO / GR / PI / SI and
convert can follow. Stock checked first makes it *"更加准"*.

| # | Criterion | Verdict | The number |
|---|---|---|---|
| 1 | Every document syncs on create, convert AND edit | **LIVE — see `docs/generated/autocount-coverage.md`, not this row** | **This row said `BUILT, GATED SHUT, NOT WIRED` until 2026-08-18 and every number in it was overtaken by events within a day.** The owner turned `scm.autocount_writeback` on for company 1 on 2026-08-13, `AC_SYNC_URL` has been set at `backend/wrangler.toml` since 2026-08-11 (#2030), and the queue has sent documents — `HC-SO-2608-001` / `-002` and the six document types that followed on 2026-08-17. Which operations are PROVEN against the live book is generated on every run from `backend/scripts/data/ac-live-proof.json`; do not restate it here, which is exactly how four coverage tables came to disagree |
| 2 | Compartment and variant aligned, and their relationships aligned | **PARTIAL, and far better than the first measurement said** | PO sofa compartment **213 / 219**, SO sofa **262 / 272**. The class "no compartment at all" is **empty**. Company 2 clean on all four chain legs; company 1 carries **0** wrong item codes on every leg. SO to PO piece-set mismatches went **8 to 2**, and both survivors are correct outcomes. Six real defects remain, on `HC-PO-009469` and `HC-PO-009596` |
| 3 | Stock balance reconciles, and Remark 2 agrees with ERP stock status | **BALANCE RECONCILES with every delta explained. STATUS moved and is still moving** | Per-warehouse agreement **917 of 976 cells (94%)**; 8 of 15 warehouses agree to the unit. `warehouse_id` **13,837 verified** against AutoCount (7,800 on exact `DtlKey`), **0 miswarehoused**. Sofa READY **0 to 70**, lots with `batch_no` **0/20 to 103/123**. Status-axis disagreements **151 to 126** |

**Every remaining unit of the +157 net stock delta sits in a named class:** 83 migration cut-off,
50 AutoCount negatives, 14 the known double-ship, 13 present at seeding. Nothing is unexplained,
so the owner's *"by right they should agree"* premise holds.

> **Provenance note on the criterion-3 figures.** The per-warehouse split (917 / 976), the
> `warehouse_id` verification (13,837 / 7,800 / 0 miswarehoused) and the +157 class breakdown come
> from the re-measure in **PR #1947** (`docs/stock-criterion-close`), which is still open. The copy
> of `docs/stock-reconciliation.md` on `main` is the earlier 808-line version and stops at the
> item-level figure (471 of 505 items, 93%) with the per-warehouse split explicitly marked
> unmeasured. If you grep `main` for 917 and do not find it, that is why — land #1947.

Criterion 1 is the one that is genuinely not done. Criteria 2 and 3 are measured and largely
closed. **The ERP is not the system of record. Staff are on AutoCount and must stay there until
the runbook below is finished.**

---

## 1. The Friday execution runbook

Strictly ordered. Each step names **who** does it, **how you know it worked**, and **how to undo
it**. Do not start a step until the previous one is verified — the whole point of the order is
that a failure is small and local when it happens.

Three rollbacks, memorised before you start:

| To undo | Do this |
|---|---|
| The service | Stop it, restore `C:\Temp\AcSyncService.prev.exe`, start it |
| The sync | `UPDATE scm.app_config SET value = 'off' WHERE key = 'scm.autocount_writeback';` |
| The freeze lift | `UPDATE scm.app_config SET value = '1', updated_at = now() WHERE key = 'scm.write_freeze';` — Houzs is completely frozen again inside 30 seconds |

**Two tracks, and step 0 comes first.** Step 0 is data repair: it runs entirely under the freeze,
touches no staff, and needs nobody at the office. Steps 1 to 6 are the sync, and step 3 needs a
person standing at the AutoCount machine. Do step 0 first regardless, because syncing data you
already know to be wrong just copies the error into a second system.

### Step 0 — Under the freeze: re-sync the drift, measure per line, repair the losses

**Who:** an agent. **Staff impact:** none, the freeze stays fully on. **Blocks:** nothing
mechanically, but doing it after the sync is switched on means repairing AutoCount too.

**0a. Re-export and top up first.** Both systems have been running, so the cutover snapshot is stale
by however many documents AutoCount has moved since 2026-08-09. **Do this before touching anything
else**, or you will be repairing new problems with old data. The 10 known post-migration receipts
are the floor, not the number.

**0b. Run `check-migration-fidelity` (PR #1981) and treat its output as the work list.** It is the
only check that reads per line and per field. Every finding in section 9.1 came from it and **none
of them was visible to the aggregate checks**, which were all passing at the time. Diff its numbers
against section 9.1: anything new is either 0a's drift or a regression, and you need to know which
before you repair anything.

**0c. Re-run the other standing checks** (section 7.3) and diff them against the figures there.

**0d. Repair the pure LOSSES first, in this order.** Each is a straight read of a column we already
have — a copy, not a decision — so each carries the least risk and shrinks the surface of everything
after it:

| Order | Repair | Why it is safe |
|---|---|---|
| 1 | The **101 missing delivery dates** — one misspelled key (`l.DelivDate` against a column named `DeliveryDate`) | Nothing to judge. Pure loss, no wrong value |
| 2 | The **130 over-received lines** — copy `PODTL.TransferedQty` to the PO line **and** to its migrated GRN line | Touches no inventory movement, because migrated GRNs never posted one. Repairing only the PO line leaves the GRN wrong |
| 3 | The **5 zero-quantity lines written as 1** (`Math.round(num(l.Qty)) \|\| 1`) | Copy AutoCount's zero |
| 4 | The **42 still-outstanding lines that never arrived** — import what is missing | The document is already there; the line is not |

**Verify:** re-run `check-migration-fidelity` after each repair and read the per-field group, not the
script's own `APPLIED` line. A repair that does not move its field's count did not happen.

**Undo:** each of these writes a value AutoCount already holds, so the correction *is* the rollback —
re-copy. Nothing here deletes anything, and none of it moves stock.

**Then, and only then, D9 and D10** (the sofa round-trip, section 12). Step 0d before that is
deliberate: a loss is cheap and safe to repair, a reconstruction is not. And the two are related —
**24 of the 42 missing lines are sofa builds.**

### Step 1 — Rebuild the clean service on the office host

**Who:** an agent driving the office host, or IT. **Blocks:** everything.

The service running right now is a **temporary self-test build** (section 6). It must be replaced
before anything else happens. The clean source is already sitting in the SQL bridge
(`tempdb.ac_src_bridge`, section 4.3) and the rebuild is **one click on the intact LINQPad
"Query 2"** — that query reassembles the parts, substitutes `__DBLINE__` and `__BOOK__`,
compiles with `csc.exe`, swaps the exe, and writes the build log back to the bridge at `seq = -3`.
Full procedure: `docs/autocount-service-deploy.md` section 2.

**Verify:** read the build log from the bridge (`seq = -3`), then

```
curl -X POST http://localhost:8900/health -H "X-API-KEY: %ACKEY%"
```

must answer `{"ok":true,"book":"AED_HOUZS","service":"AcSyncService"}`. The `book` field is now
substituted from the same value that builds the DB connection line, so **it can no longer name a
book the service is not connected to** — it used to be a separate hardcoded constant, and a build
pointed at a test book still announced the live one on the single signal an operator uses to check
exactly that.

Also confirm the substitution took: `findstr /C:"__DBLINE__" AcSyncService.build.cs` must count
**0**. The placeholder now appears in **three** methods — `Session()`, `DtlKeys()` and
`CreatedLines()` — so a replace that only hits the first occurrence will not compile. Delete
`AcSyncService.build.cs` afterwards; it contains the database password.

**Undo:** stop the service, restore `AcSyncService.prev.exe`, start it.

### Step 2 — Run runbook 4.1 to 4.5 against the live book, on a throwaway document

**Who:** an agent, or IT. **Blocks:** the tunnel, and everything after it.

These five checks have **never passed**. Section 7 records the two reasons why, and both are
already solved on paper, so nobody should rediscover them:

- **Do not use `AED_TESTING`.** It is an evaluation book and it has exhausted its 500-transaction
  limit. It cannot accept another write of any kind.
- **The live book enforces master-data foreign keys the test book does not.** Two were hit in
  succession: `FK_SO_SalesAgent`, then `FK_SO_SalesLocation`. Use values that exist:

| Field | Values known to exist in `AED_HOUZS` |
|---|---|
| `SalesAgent` | `OTHERS`, `KINGSLEY`, `MK`, `WW`, `ALEX`, `SIANG` |
| `Location` / `SalesLocation` | `KL`, `HQ`, `KELANA.J`, `C&C DISP`, `C&C K.J`, `EM DISP` |
| A real live SO, for shape | `DebtorCode 300-C002`, `SalesAgent 'JAMES SEOW'`, `SalesLocation 'PG'`, `CurrencyCode MYR`, `DisplayTerm C.O.D.` |

The five checks, from `docs/autocount-service-deploy.md` section 4:

| # | What | Pass |
|---|---|---|
| 4.1 | `POST /create-so` with two detail lines | the response carries a `lines` array, one entry per detail, each with a non-zero `DtlKey` and the `ItemCode` that was sent, in order |
| 4.2 | `POST /edit` with a line carrying **no** `DtlKey` | HTTP 500, body contains `REFUSED`, **and re-opening the document shows the original line count unchanged**. The second half is the real test |
| 4.3 | `POST /edit` addressing a line by its `DtlKey` | the line count does not change and the quantity does |
| 4.4 | `POST /edit` with `IsNewLine: true` | exactly one line is added |
| 4.5 | `POST /edit` with `Retire: true` | the line still exists, `Qty` is 0, `Desc2` begins `[ERP-CANCELLED]`, and `SELECT Qty - ISNULL(TransferedQty,0)` returns 0 or less |

**Then cancel the throwaway document with `/cancel`. Never delete it.** 4.2 is safe on the live
book by construction: a passing guard writes nothing.

Run them by hand with `curl` against `http://localhost:8900`, per
`docs/autocount-service-deploy.md` section 4. The automated harness that was doing this — the
self-test block described in section 6 — was a temporary injection into the source and is **not in
this repository**; the clean build removes it, and that is correct. Do not re-inject it just to
save typing five requests.

**Verify:** all five read PASS, and the throwaway document is present in the book with
`Cancelled = 'T'`.

**Undo:** the document is cancelled, not deleted, which is the whole point. Nothing else changed.

### Step 3 — DONE 2026-08-11. The tunnel fronts the service and the runbook PASSED

**Do not re-plan this step. It is finished, and the four "this machine cannot
reach it" findings that were true this morning stopped being true at the moment
the hostname was repointed.** They are recorded here because a later session
re-derived them from the pre-repoint state of this document and concluded the
whole thing was unrunnable.

| what was true this morning | why it is no longer |
|---|---|
| ZeroTier to `10.147.17.100:8900` answers 400, and 403 with a forged Host | Still true, and irrelevant. The listener prefix is `http://localhost:<port>/`, so http.sys serves loopback only. **cloudflared connects from loopback ON that host**, so the tunnel path works where a direct one cannot |
| `it-houzs.dev` does not front AcSyncService | Correct, and it never will. **`autocount.houzscentury.com` does**, since the owner repointed it |
| the API key exists only in `C:\Tempc-svc-key.txt` on the host | It was downloadable over the old file server, and is now the `AC_SYNC_KEY` Worker secret. **Set.** |
| no `AED_HOUZS` SQL password locally | True and not needed: the HTTP path needs the API key, not the database |

**The evidence, from an ordinary workstation over the public tunnel:**

```
POST https://autocount.houzscentury.com/health
  -> {"ok":true,"book":"AED_HOUZS","service":"AcSyncService"}

/create-so ZZERP-0001, two lines  -> lines[] with DtlKey 894957, 894958   (4.1 PASS)
/edit  no DtlKey                  -> HTTP 500 REFUSED                     (4.2 PASS)
/edit  DtlKey 894957, Qty 9       -> ok                                   (4.3 PASS)
/edit  IsNewLine                  -> ok                                   (4.4 PASS)
/edit  DtlKey 894958, Retire      -> ok                                   (4.5 PASS)
/cancel                           -> ok, cancelled and NOT deleted
```

`ZZERP-0001` stays in the book, cancelled, per 不可以删只可以 cancel. **Do not
delete it.** `GET /ac-svc-key.txt` now returns 405 from the service, so the
file server that had been publishing the key is no longer in front — see
`docs/autocount-writeback-exposure-coe.md`.

**What is still NOT proven:** anything on the ERP side. Nothing has been driven
from an ERP save — `scm.autocount_writeback` is still `off` and the outbox still
holds zero rows. And the exe on the host is still the pre-`/ensure-masters`
build, so a document naming a new master would still fail there.

<details><summary>The original Step 3, kept because the rollback and the
configuration notes in it are still correct</summary>

### Step 3 (original) — Stand up the tunnel and set `AC_SYNC_URL` + `AC_SYNC_KEY`

**Who: IT, physically at the office machine. This is the only step that needs that, and it blocks
every step after it.**

A Cloudflare Worker cannot join a ZeroTier network, so ZeroTier is not and cannot be the runtime
transport. The bridge that exists today is `it-houzs.dev`, Cloudflare-proxied through to the
office box — proven live on 2026-08-11: `HEAD https://it-houzs.dev/` returns 404 with
`Server: cloudflare` and a Kuala Lumpur PoP, and `GET https://it-houzs.dev/SalesOrder/getAll`
returns **401**, which means the middleware behind the tunnel is running and answering. Copy that
shape and point a second route at `AcSyncService` on port 8900.

The tunnel configuration lives on the office machine and **exists nowhere in this repository.**
That absence is itself a finding — write it down this time.

Then:

```
# backend/wrangler.toml, currently commented at line 34
AC_SYNC_URL = "https://<the new tunnel hostname>"
```
```
wrangler secret put AC_SYNC_KEY      # must match C:\Temp\ac-svc-key.txt on the host
```

**Verify:** `GET /health` returns `{"ok":true,"book":"AED_HOUZS"}` **through the tunnel, from a
Worker** — not from the office LAN. A localhost curl proves nothing about the tunnel.

**Undo:** re-comment `AC_SYNC_URL` and redeploy. `drainAutoCountOutbox` returns
`ac_service_not_configured` before it reads the queue, so an unset URL is a complete stop.

</details>

### Step 4 — Turn on `scm.autocount_writeback` for company 1

**Who:** an agent or IT. **Blocks:** any document reaching AutoCount.

```sql
UPDATE scm.app_config SET value = '1' WHERE key = 'scm.autocount_writeback';
```

Same grammar as the freeze: `off` / `all` / a comma-separated company id list. Checked twice by
design — at enqueue, so nothing accumulates while off, and again at drain, so a flag flipped off
after rows were queued stops the push and leaves the rows `pending` rather than `failed`. Cache
TTL is 30 seconds.

**Verify:** with the freeze still on, nothing should be enqueued yet, so
`SELECT count(*) FROM scm.autocount_outbox` should still be 0. That is the correct answer at this
point: the switch is armed, not fired.

**Undo:** set it back to `off`. One statement, 30 seconds.

### Step 5 — Lift the write freeze for ONE area, company 1 only, with a pilot cohort

**Who: the owner. His standing instruction is 解冻我跟你说你才做 — nobody lifts without him.**

Use the staged-lift grammar (`docs/write-freeze-staged-lift.md`). Actions -> **SCM write freeze
(on/off)** -> Run workflow, with `target=prod`, `state=on` (the freeze stays ON — you are naming
exceptions to it), `companies=1`, `areas=scm.sales.orders`.

```sql
-- the same thing directly, if you prefer
UPDATE scm.app_config
   SET value = '1 - scm.sales.orders', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

Read `1 - scm.sales.orders` as *freeze company 1, minus sales orders*. `areas` is **cumulative**,
not a delta: a later stage must repeat the earlier ones or they close again. A value nobody can
parse freezes everything; a typo in an area name can never open anything.

Lifting `scm.sales.orders` also opens `/so-amendments`, `/quotes`, `/pwp-codes`, `/scan-so`,
`/scan-payment` and `/slips`. Check that column before you lift — it is the part that surprises
people.

**Verify, in this order:**

1. Wait 30 seconds. The middleware caches per isolate; a lift that "did not work" has usually just
   not expired.
2. Actions -> **SCM write freeze — status (read-only)**, or `GET /api/scm/write-freeze`. Confirm
   `openAreas` is what you intended and `unresolvedTokens` is empty.
3. **Have one ordinary member of staff save one real record** — not an `scm.admin` account, which
   bypasses the freeze and would have succeeded either way. This is the only step that proves it.
4. Check a module you did **not** open still refuses. If everything saves, the value is `off` when
   you meant a lift.

**Undo:** `UPDATE scm.app_config SET value = '1', updated_at = now() WHERE key = 'scm.write_freeze';`
or the workflow with `areas` blank. Houzs is completely frozen again inside 30 seconds.

**This is the only step that is hard to reverse in substance rather than in configuration.** Once
staff have edited, rolling back means reconciling human work, not re-running a script.

### Step 6 — Watch one real document reach AutoCount, then widen one area at a time

**Who:** the owner decides each widening; an agent watches.

Create one SO, look at it in AutoCount. Edit it, look again. Cancel one, and check the owner's own
outstanding rule — not converted to DO and not to IV — computes **identically on both sides**. The
acceptance query is already written in our own code (`AcSyncService.cs:403`):

```sql
SELECT h.DocNo, d.DtlKey, (d.Qty - ISNULL(d.TransferedQty, 0)) AS outstanding_qty
  FROM SODTL d JOIN SO h ON h.DocKey = d.DocKey
 WHERE h.Cancelled = 'F'
   AND (d.Qty - ISNULL(d.TransferedQty, 0)) > 0;
```

The ERP side must produce the same `(document, line, outstanding_qty)` set for every document with
`linked_ac_docno IS NOT NULL`, keyed through `linked_ac_dtlkey`. **Equal, not merely overlapping.**

Then widen in the order the business needs, one stage per run, verifying between each:

| Stage | `areas` |
|---|---|
| 1 | `scm.sales.orders` |
| 2 | `scm.sales.orders,scm.procurement.po` |
| 3 | `+ scm.procurement.grn` |
| 4 | `+ scm.sales.delivery` |
| 5 | `+ scm.procurement.pi,scm.sales.invoices` |
| 6 | `state=off` — the freeze is over |

Do **not** enable the convert push before D14 is fixed (section 9): `enqueueConvert` sends no
`DtlKeys`, so the service falls through to selecting **every** still-outstanding line on the
parent, and an ERP DO shipping 2 of 5 lines would produce an AutoCount DO containing all 5.

---

## 2. The traps

Every one of these cost hours this week and would cost them again.

**A log line saying APPLIED is not evidence, and neither is a green badge.** Both halves of that
were demonstrated this week.

- `refresh-sofa-colours.mjs` printed `APPLIED - stamped 146 sofa lines` on **three** separate runs.
  A read 29 seconds later showed nothing had changed, so it was written down as a lost write. It
  was worse than that: the write had landed and had **destroyed the column** (section 9).
- Two `recompute-so-allocation` runs finished with GitHub `conclusion: success` while their own
  output said `ok=false ... reason=ad.localeCompare is not a function` and **`NOT COMMITTED`**.
  Read the notices, not the badge: `gh run view <id> --log | grep '##\[notice\]'`.
- `apply-sofa-compartment-corrections.mjs` logged `removed 2`. The two rows really were gone, and
  the record that a third piece had ever been on either order was gone with them — which was only
  established by asking the **database** for the current rows, not by reading the log.

The structural difference is one word: the API shim appends `RETURNING` and counts rows; a script
reads a command tag and never re-checks. **Confirm every `APPLIED` with an independent read on a
fresh connection.**

**Verify schema claims against the live database, not migration files.** The partial unique index
`uq_inv_mov_do_source` on `scm.inventory_movements` was believed not to exist — migration 0230's
own comment enumerates four non-unique indexes and no unique one. It exists. Four partial unique
indexes are live, ported from 2990 by hand, present in **no file in this repository**. Read live
from `pg_indexes` on 2026-08-11 (Actions run **31417585775**). That index is why editing a shipped
DO never reached the stock ledger.

**`linked_ac_dtlkey` is NOT independent evidence.** It was built by a backfill that used the same
collided key the variant refresh used. Using it to corroborate a variant value is circular. Go back
to the AutoCount export's own `DtlKey` — unique across all **13,588** export rows — or to the
document text.

**Keyboard and paste through UltraViewer silently drop characters.** Do not type source, SQL or
JSON into the remote desktop. Push it through the SQL bridge (section 4.3) and let the far side
read it. Every character that reaches the bridge is the character you sent.

**LINQPad runs only the SELECTED text if anything is selected.** A stray selection once ran a
single word instead of the whole script and reported success. Click into the editor and press
`Ctrl+A` — or click away from the text — before running.

**Never branch from local `main` in this repository.** It runs hundreds of commits behind
`origin/main`. An audit branched from it and "proved" that a column added months ago does not
exist; every conclusion had to be thrown away. Make any agent print
`git rev-list --count $(git merge-base origin/main HEAD)..origin/main` before you read its
findings.

**A dry-run must print exactly what apply will write.** One repair's log said `LEFT AT ZERO` for
two lines that apply would have priced at RM 2,051.50. Build the plan once and let both the log and
the writer consume that same list.

**CI green is not correctness.** Every wrong-value defect in section 9 passed CI. They were caught
by adversarial review — an agent whose task was to refute the work, reading the diff rather than
the report, and re-running the tests with the fix reverted to prove they fail without it.

**Read the failing response before writing down a cause.** Line photos were recorded as "files
never uploaded", then as "bucket name not configured". Both were wrong. The actual response was
`500 signing_failed: R2_ACCESS_KEY_ID not configured`, while the same object served fine through
the proxy route. The objects were never missing.

---

## 3. The rules this migration runs under

Owner's, non-negotiable. Each was written after something went wrong, so none is theoretical.

### 3.1 A migration COPIES. It never computes.

> 跟着 autocount 的 document 就对了，我们 migrate data 不可以更改数据啊，更改的话数据就不一样了啊
> — owner, 2026-08-11

For every field, name the AutoCount column that is its source and read **that**, per line. Where
AutoCount is blank, the ERP is blank. Where AutoCount is ambiguous, the row is **skipped and
reported**, never guessed. "The data is different" is the failure, even when the invented value
looks more useful than a gap.

Three separate repair lanes independently drifted into inference and each produced a wrong row
that no test caught:

| what was about to be written | why it was wrong |
| --- | --- |
| `HOK-DIVAN ONLY (K)` RM 470 stamped onto a `(Q)` line, 3 units | the key was `(document, Desc2)` and **Desc2 does not carry size — size lives in the item code**. `(Q)`'s own median is RM 325, so this was +44.6% |
| `HOK-2041 (A) (SS)` RM 641.50 onto a `(Q)` line | same defect, +9.7% |
| `HC-PO-009633` two lines written as "ordered 1, received 2" | read from an export column aggregated on `(DocNo + ItemCode)` |
| a mattress PO line about to be dedicated to a pillow SO line | two AutoCount lines looked identical on every field the ERP stores but differed on `FromSODtlKey`, and those two keys pointed at **different products on the same order** |

Inference also defeats the guards: once a wrong price is stamped, the line reads as "priced", so
the zero-cost receipt gate never fires on it again.

### 3.2 不可以删，只可以 cancel

Nothing is ever DELETED — not a document, not a line, not a stock movement. Corrections are
compensating writes. This forbids implementing an edit as delete-and-recreate (which would also
destroy AutoCount's own document links and audit trail), and forbids fixing a duplicated stock
movement by removing the duplicate.

### 3.3 The ERP is the only editing surface, once live

暂时只可以在 erp 改. Sync is one-way, ERP as master, so there is no merge policy to design and no
conflict to resolve. The replacement risk is staff editing in AutoCount out of habit, which a
one-way push cannot notice: the next ERP edit silently overwrites it, or it survives forever if
that document never syncs again. **Drift detection is required regardless.**

### 3.4 A lost sync must be impossible to miss

ZeroTier (`10.147.17.100,55500`) carries the analysis link, and keeping it up is the only
mitigation available. A save that succeeds in the ERP while its sync is silently lost must be
impossible. The justification for the durable queue is making failure **visible**, not distrusting
the link.

### 3.5 Outstanding, defined by the owner

An SO is outstanding only if it is **not converted to a DO and not invoiced**, and not cancelled.
Converting to a PO does **not** make it non-outstanding. Same shape for a PO: outstanding until
received. That predicate is already implemented on the import side —
`ac-outstanding-so.json.gz` is defined as *outstanding = 还没转 DO* (13,703 rows) and
`ac-so-iv-excluded.json.gz` (129 rows) carries the SOs invoiced without a DO — so the acceptance
test has a definition to reuse, not one to invent.

---

## 4. The pipeline, end to end

### 4.1 AutoCount to ERP — the direction that has already run

```
live AED_HOUZS (SQL Server 2019, ZeroTier 10.147.17.100,55500)
   |  read-only SELECT, on-site, pyodbc / SQL Server Native Client 11.0
   v
backend/scripts/data/*.json.gz         <- committed snapshots, READ-ONLY ORIGINALS
   |  node backend/scripts/import-ac-*.mjs
   |  triggered by .github/workflows/<same-name>.yml, workflow_dispatch ONLY
   |  reads the database through secrets.DATABASE_URL
   v
Supabase Postgres, schema scm
```

Four properties of that pipeline matter more than the scripts themselves.

**The snapshots are read-only originals.** `backend/scripts/data/*.json.gz` is not to be edited.
Replace a whole file or nothing, and add a line to the ledger's section 6 when you do. Every file
records the AutoCount view it is a snapshot of, its row count, and which importer consumes it.

**Everything is `workflow_dispatch`, dry-run by default.** `apply=1` — lowercase — is what writes.
Deletion and number-minting scripts additionally require
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"`. The switch is per-run, so a dry-run and an apply are two
separate acts by a human.

**The answer is the run's `##[notice]` lines, never the badge.** Read-only checks exit 0 for every
legitimate answer, so a red job means the check broke, not that the answer is bad. And
`conclusion: success` does not mean "written": two runs in the ledger's W12 were `success` while
reporting `canonical result: ok=false` and `NOT COMMITTED`.

```
gh run view <id> --log | grep '##\[notice\]'
```

**One file is a ruler, not cargo.** `ac-outstanding-now.json.gz` records only what AutoCount said
at the instant it was exported (`scratchpad/export-outstanding-now.py`). Measuring `MISSING 0`
against it means "consistent with this ruler". To get a fresher answer, re-export the ruler first.

The volumes actually moved, from the ledger:

| Wave | What | Result |
|---|---|---|
| W0 | master data (SKU / model / supplier) | products +493, bindings +1,221, then +296, +10; models +144; suppliers 35 filled + 1 new |
| W1 / W2 / W6 | Sales orders — two non-sofa rounds plus sofa | 2,275 then +202 then +24 orders; sofa +450 orders / +1,289 items. Sofa decode `442 decomposed, 89 placeholder (never guessed)` |
| W3 | outstanding purchase orders | 172 POs cumulative |
| **W4** | **balance snapshot opening — the only time physical stock entered the ERP** | **1,020 cells, +9,679 units, 1,020 `ADJUSTMENT` movements** (run 31327230655) |
| **W5** | relayer the flat opening into real FIFO layers | 963 cells, **2,261 layers**; 8,611 of 9,679 units got a real cost. Total unchanged (run 31346929790) |
| W7 / W9 | SO-linked POs, including already received | 378 / 378, `no inventory movements written — by design` |
| W10 | stamp AutoCount GR / PI numbers onto POs | 241 then 48 POs; `No GRN was created and no stock moved — by design` |
| W11 | give imported SO lines a `warehouse_id` | **13,885** lines (run 31373582517) — KL 9,434 / PG 3,506 / SRW 722 / SBH 223 |
| W12 | allocation recompute | `ok=true linesFlipped=1181 ordersAdvanced=147 ordersRegressed=0` (run 31374177085) |
| W13 | migrated GRNs and DOs | **291 GRNs**, **25 DOs**, both `No inventory movement written — by design` |
| **W14** | balance re-run after the sofa exclusion moved to category | **+205 units**, 2 cells (run 31383828663) |
| W16 | renumber migrated documents to AutoCount's own numbers | `renamed: 511`, then `renamed: 49` |
| W18 | give migrated POs their delivery date from their own lines | `401` of 449; 48 still blank because no line carries a date either |

Iron law from the ledger: **physical stock entered the ERP once, from `AC_CUTOVER`
(9,679 units / 2,261 layers), plus W14's +205. The 291 migrated GRNs and 25 migrated DOs never
post a movement and never will.**

### 4.2 ERP to AutoCount — the direction that is built and switched off

```
a save in the ERP  ->  enqueueSoCreate / enqueuePoCreate / enqueueConvert / enqueueCancel / enqueueEdit
                       (six route files; each swallows its own errors and returns false,
                        so a user's save can never fail on AutoCount's account)
   v
scm.autocount_outbox            migration 0277. One row per intended operation.
                                Rows are NEVER deleted: this is the audit trail of what
                                the ERP told AutoCount. Payload is snapshotted at enqueue,
                                never recomposed at drain.
   v
drainAutoCountOutbox            on the existing */5 cron. MAX_ATTEMPTS = 6, DRAIN_BATCH = 20.
                                Oldest first, so a parent is ahead of its child in the batch;
                                a row whose parent has not drained waits WITHOUT burning an attempt.
   v
AC_SYNC_URL  ->  Cloudflare tunnel  ->  AcSyncService.exe on the office host, port 8900
   v
the licensed AutoCount 2.2 SDK  ->  live AED_HOUZS
```

Two independent gates keep it dark: `AC_SYNC_URL` unset, and `scm.app_config` key
`scm.autocount_writeback` seeded `'off'` by migration 0277. Both must be opened.

What is **not** built, and it is the whole alarm layer: no alarm (a `console.error` in a Worker is
not an alarm), no backlog monitor, no queue-depth metric anywhere a human looks, and no
reconciliation sweep that independently re-reads AutoCount. With a fixed 5-minute cron and
`MAX_ATTEMPTS = 6`, a row gives up permanently after roughly **30 minutes** of outage — a tunnel
down for a long lunch would dead-letter every document created in that window.

### 4.3 `tempdb.ac_src_bridge` — the only channel that does not depend on a remote desktop

`AcSyncService.cs` compiles only on the AutoCount host, against licensed assemblies that exist
nowhere else. The host is reachable two ways: a remote-desktop session (UltraViewer), and a
direct SQL connection over ZeroTier to `10.147.17.100,55500`. **Typing or pasting through
UltraViewer silently drops characters**, which makes it unusable for moving 600 lines of C#.

So source travels through SQL. A scratch table in `tempdb`:

```sql
-- tempdb.ac_src_bridge (seq int, part nvarchar(max))
```

| `seq` | Direction | Carries |
|---|---|---|
| `>= 0` | Desktop -> host | the source, split into **4000-character parts**, one row per part, reassembled in `seq` order |
| `-3` | Host -> desktop | the **build log** — the `csc.exe` output, the placeholder count, the swap result |
| `-4` | Host -> desktop | the self-test verdicts written by the temporary build (section 6) |

It is the **only** channel that needs neither a screen nor a keyboard, so it is the one to use for
anything longer than a filename. It is also why the LINQPad query on the host is the build button:
the query reads the parts, writes the file, compiles it, and posts the log back. Nothing has to be
read off a screen.

**This mechanism is documented here and nowhere else.** It exists in no other file in the
repository, which is exactly why it is written down.

*Provenance: established at the host on 2026-08-11. There is no Actions run to point at, because
none of it runs in CI — the bridge and the LINQPad query live on the office machine. The
corroborating artefact in this repository is the self-test block, which writes its verdicts to the
same table at `seq = -4` using the same `INSERT INTO ac_src_bridge (seq, part)` shape.*

---

## 5. The gates — what is holding, verified 2026-08-11

Four things are keeping the two systems apart. Each was read back rather than remembered.

| # | Gate | State | How it was verified |
|---|---|---|---|
| 1 | `scm.app_config['scm.autocount_writeback']` | **`off`** | Seeded `'off'` by migration `0277`, which is on `main` and deployed. Read twice at runtime by design — at enqueue and again at drain |
| 2 | `scm.app_config['scm.write_freeze']` | **`1`** — company 1 frozen, every area | Live read by `check-write-freeze`, **run 31458625039**. Set `2026-08-10T07:53:24Z`. Areas still paused: **24**. Areas reopened: **0** |
| 3 | `AC_SYNC_URL` | **0 uncommented occurrences** in `backend/wrangler.toml` | Commented at line 34. `drainAutoCountOutbox` returns `ac_service_not_configured` **before it reads the outbox** (`autocount-outbox.ts:834`) |
| 4 | `scm.autocount_outbox` | **0 rows** | Live read, 2026-08-11. Not "0 pending" — **0 rows of any status.** Nothing has ever been enqueued, because gate 1 is checked at enqueue too |

Gate 4 is the strongest of the four and the easiest to misread. The outbox is append-only by
design — rows are never deleted — so an empty table is not a drained queue, it is a queue that has
never had anything put in it. **No ERP document has ever been offered to AutoCount.**

Two things to know before touching any of this:

- A per-module staged lift now **exists** (`set-write-freeze`, PR #1967), but **zero areas have
  been lifted**. The capability is not the same as the act.
- Enforcement trails the database row by up to **30 seconds** (middleware cache TTL, per isolate).
  Do not judge the effect of a change in the second after you make it.
- Routers with no L2 area key — `/hr`, `/staff`, `/localities`, `/currencies`, `/categories`,
  `/state-warehouse-mappings`, `/pos-cart`, `/personal-quick-picks`, `/sales-analysis` — cannot be
  lifted individually and stay paused until the whole company is unfrozen.

2990 (company 2) is unaffected and trades normally throughout. It is not part of this migration,
and the per-company design is why a cutover on Houzs never stopped a second business.

Unfreezing is the owner's call alone: *"解冻我跟你说你才做."*

---

## 6. The office host, exactly as it stands right now

**This is the least-documented part of the whole migration and none of it is in git.** It is
written out in full because on Friday somebody has to walk up to that machine.

| Path | What it is |
|---|---|
| `C:\Temp\AcSyncService.exe` | **A TEMPORARY SELF-TEST BUILD. Replace it.** See below |
| `C:\Temp\AcSyncService.prev.exe` | The rollback. Stop, restore, start |
| `C:\Temp\ac-svc-key.txt` | The `X-API-KEY` the service requires. Must match the `AC_SYNC_KEY` Worker secret |
| `C:\Temp\ac-sync-service.log` | Where the service writes. A `CreatedLines(...) failed:` line here is what a missing `lines` array in a create response means |
| `C:\Temp\ac-svc-port.txt` | The port, as a FILE not a constant — 8899 turned out to be pinned inside `http.sys` by an orphaned listener registration from the cutover file server. Default 8900 |
| `C:\InistateConnector\setup.json` | Where the SQL credentials are read from at build time (`dbUsername` / `dbPassword`). Never copied into source |
| `C:\Program Files\AutoCount\Accounting 2.2\` | The licensed assemblies. `csc.exe` references five of them |
| LINQPad, **"Query 2"** | Intact, and it is the build button. Reassembles the bridge parts, substitutes, compiles, swaps the exe, posts the log back at `seq = -3` |
| `tempdb.ac_src_bridge` | **Now holds the CLEAN source** — the shipped service, without the self-test |

### The running build is a self-test build and it must be replaced

The exe currently on disk was generated by `gen_selftest.py`, which injects a temporary block into
the real source. On **every start**, seven seconds after the listener comes up, a background
thread tries to create a Sales Order numbered **`ZZTEST-0001`** in the **live `AED_HOUZS`** book,
then run runbook checks 4.1 to 4.5 against it and cancel it.

What it actually does today: **it fails at `FK_SO_SalesLocation` and creates nothing.** The
document is never written, so nothing is left behind in the book. But it is still a build that
attempts a live write on every restart, and that is not a thing to leave running.

The block is defensive in the right ways, which is why it is safe to have left running while the
verdicts were being chased:

- It aborts without touching anything if `ZZTEST-0001` already exists
  (`SELECT COUNT(*) FROM SO WHERE DocNo='ZZTEST-0001'` must be 0).
- It ends with `/cancel`, never a delete, and asserts the row is still present with
  `Cancelled = 'T'`.
- It writes its verdicts to the bridge at `seq = -4`, so they can be read over SQL without a
  screen.

**Step 1 of the Friday runbook replaces it with a clean build.** The clean source is already in the
bridge; the rebuild is one click on Query 2.

*Provenance for this whole section: the office host, 2026-08-11. None of it is in git and none of
it has an Actions run, because none of it runs in CI. What this repository does hold is the
generator — the injected block and the script that injects it into `AcSyncService.cs` — so the
behaviour described above can be read rather than taken on trust. Anyone who changes what is on
that host should edit this section in the same sitting; it is the only inventory of that machine
that exists.*

### The two service-side fixes that are in the source but not yet in the running exe

Both are in `AcSyncService.cs` on the branch `fix/acsync-overqty-uncompilable` and both matter on
Friday:

- **`/health` can no longer name the wrong book.** `BOOK` is now `__BOOK__`, substituted at build
  time from the same value that builds the DB connection line. It used to be a separate hardcoded
  `"AED_HOUZS"`, so a build pointed at a test book still announced the live one on the one signal
  an operator uses to check exactly that.
- **The over-transfer handler was uncompilable and is now gone.** The SDK raises a WinForms dialog
  for over-transfer, and the obvious fix is to subscribe to the event and answer it
  programmatically. That event's `EventArgs` type is **not public**, so a handler that NAMES it
  could never have compiled. The condition was instead made **unreachable**, by only ever
  transferring what is outstanding.

  > **CORRECTED 2026-08-17.** Both halves stopped being true. *"It cannot be subscribed at all"*
  > is wrong: a handler does not have to name the args type. .NET's relaxed delegate binding
  > matches a method declared with `object` parameters to a delegate whose parameters are any
  > reference types, so `Delegate.CreateDelegate` binds one — which is what `Watch()` in
  > `AcSyncService.cs` now does. And *"unreachable"* stopped holding the day the ERP began naming
  > `DtlKeys`: `DtlKeys()` returns a supplied list verbatim, so the
  > `(Qty - TransferedQty) > 0` predicate is never evaluated for those lines. The event is now
  > subscribed and **logged only** — nothing answers it, because confirming an over-transfer would
  > silently accept shipping more than was ordered.

---

## 7. Verification — what has and has not happened

### 7.1 Runbook 4.1 to 4.5 have NOT passed

Not one of them. Two real obstacles were found, and both are recorded here so nobody rediscovers
them on Friday morning:

**`AED_TESTING` cannot be used.** It is an evaluation book and it has exhausted its
**500-transaction limit**. That is why the plan of "prove it on the test book first" — which is
what `docs/autocount-service-deploy.md` section 4 tells you to do, and what
`docs/archive/autocount-sync-coverage-2026-08-11.md` step 9 assumes — does not survive contact. The verification has
to happen on the live book, on a throwaway document, cancelled afterwards.

**The live book enforces master-data foreign keys the test book does not.** Two were hit in
succession, each only revealing the next: `FK_SO_SalesAgent`, then `FK_SO_SalesLocation`. A create
that satisfies the first fails on the second, so fixing one and retrying buys one attempt. The
values that exist are in section 1 step 2. Use them.

*Provenance: both constraint names, and the master-data values beside them, were read off the live
`AED_HOUZS` book on 2026-08-11 over the SQL link. Like the ledger's own whole-book counts, they are
re-runnable but cannot be pulled out of the Actions history, because they were not produced by a
workflow. That is the reason they are written down here rather than left to be rediscovered.*

### 7.2 What HAS been proved

| | |
|---|---|
| The SDK approach works headless under the licence | On 2026-08-07 a predecessor program (`AcSoService.cs`, create-SO only) wrote two real-format Sales Orders — **SO-2608-001** (AKEMI) and **SO-2608-002** (a sofa) — into the live `AED_HOUZS` book, by hand. Deliberately left uncancelled for the owner to inspect. It proves the mechanism; it proves **nothing** about any ERP flow, because no ERP flow was involved |
| The relay behind `it-houzs.dev` is alive | 2026-08-11: `HEAD /` returns 404 with `Server: cloudflare`, KL PoP; `GET /SalesOrder/getAll` returns **401**. A 401 rather than a 502 means the middleware behind the tunnel is answering right now |
| The corruption path is closed | `#1935` + `#1945`: an `/edit` whose lines carry no AutoCount identity is **refused**, not appended. The check is a pre-flight pass over every line before any detail is touched, so a refusal leaves the document exactly as AutoCount had it |
| Line identity now exists for most documents | SO **12,910 / 13,907 (92.8%)**, PO **275 / 864**. **2,316 of 2,723** SOs and **127 of 449** POs are fully covered, meaning editable |

### 7.3 The standing checks — re-run these, do not trust the numbers

Every one is on `main` with a `workflow_dispatch` workflow.

| Check | What it answers | Result 2026-08-11 |
|---|---|---|
| `check-migrated-numbering` | does every migrated document carry AutoCount's own number | **PASS** |
| `check-autocount-parity` | PO number / stock status / balance / document flow | below |
| `check-status-disagreement-why` | why each stock-status disagreement exists | **104 of 104 explained** |
| `stock-truth-check` | balance vs AutoCount, FIFO integrity, delivered COGS | below |
| `check-write-freeze` | the freeze value, in English, with the paused and reopened area lists | run 31458625039 |
| `check-cancelled-so-line-readers` | replays each cancelled-line guard's own predicate against the live rows | run 31431319394 |
| `over-receipt-check` | is an over-receipt paper-only, or did stock move | |
| `check-line-supply-trace` | which PO a not-ready line waits on, and when | |

**Document parity** — `check-autocount-parity`:

```
PO document number : 262 exact / 0 different / 1 missing (SO-012267 lacks PO-009216) / 0 supersets
balance            : 2,708 compared, 2,696 agree, 12 differ
document flow      : 427 chains agree / 0 disagree / 10 AutoCount receipts the ERP has no GRN for
                     (+12 the ERP has and AutoCount's export does not — all 12 confirmed
                      TRANSFERRED in AutoCount's own TransferedQty, so the ERP is right)
stock status       : AutoCount states one on only 404 of 2,710 orders;
                     284 agree, 104 disagree, 16 "READY (PARTIAL)" not falsifiable per category
```

**The 104 disagreements, every one with a cause** — `check-status-disagreement-why`:

| n | cause |
| ---: | --- |
| 52 | sofa has no stock in the ERP at all — the compartment round has not been run |
| 28 | an earlier order already claimed the stock — a genuine shortage, nothing broken |
| 13 | the order has no Processing Date, and the allocator gates those to PENDING regardless of stock |
| 7 | `MISC` — a charge posted as a goods line, so it can never read READY |
| 2 | the line is already fully delivered; the allocator skips it and the flag is frozen |
| 1 | stock exists but in a different warehouse |
| 1 | no stock anywhere for that product |

**Stock** — `stock-truth-check`, after the zero-cost backfill:

```
BALANCE : 2,268 cells compared (1,315 both zero); 2,232 agree
          ERP higher 35 cells / +104 units; ERP LOWER 1 cell / -1 unit
          items not mapped 0; locations not mapped 0; ERP-only 0
FIFO    : SOUND - 3,386 layers, arithmetic broken on 0; no negative or over-remaining layer;
          no shipment drew from a zero-cost layer; layers reconcile to movements
          layer value RM 2,228,410.31 vs the Inventory screen's RM 2,227,767.31 (differs by RM 643 -
          stock on an inactive warehouse or a non-active product, real but not displayed)
COGS    : 42 delivered units carry zero cost, on 28 lines - ALL of them MIGRATED lines.
          Company 1 has shipped no normal delivery order yet, so this ratio is 100% by
          construction, not a costing collapse.
```

Sofa is excluded from the balance comparison **symmetrically** — both AutoCount's 31 sofa codes and
the ERP's 77 compartment cells are held out. Excluding only AutoCount's side would make every ERP
compartment cell report as "ERP-only", a gap invented by the filter rather than found by it. The
exclusion is printed on the report, not applied silently.

**Remark 2 is `SO.Remark2`**, `nvarchar(40)`, on the AutoCount SO **header**, non-blank on **9,165**
orders. The mapping is an **identity** mapping, because `so-readiness.ts` was written to reproduce
that convention. On the 2,712 outstanding SOs every value is inside the controlled vocabulary —
**zero free text**. When staff type `READY`, AutoCount's own stock is genuinely present **99%** of
the time. The trap: the tokens name **what IS ready**, not what is pending.

### 7.4 What was checked and found NOT to be a bug

Recorded so nobody re-chases them.

- **MYR 0.00 on migrated POs is faithful.** 565 of 579 lines are unpriced in AutoCount, sofa 126 of
  126, and every null-price line carries `SubTotal` 0 too.
- **Sofa decomposition does not break item lookup.** 184 of 184 ItemCodes match, 0 decode failures.
  An earlier theory blamed decomposition for the binding failures; it was wrong.
- **Repeat conversion is deliberate.** The business ships and invoices in batches, so an SO that
  already has a DO can legitimately get another. The real guard is the **quantity ceiling**, never
  an "already converted" flag.
- **"604 array-shaped `custom_specials` rows are corrupt and should be nulled."** 679 of their 694
  strings are live picker codes, the derived cache agrees with its source on all 604 rows, and the
  renderer handles both shapes on purpose. Nulling would have deleted a correct, currently-rendering
  line item from 604 historical documents.
- **"A backfill introduced a truncation."** It did not. The fabric library holds both `BO315-5` and
  `BO315-5-FOSSIL`; there are 56 bare-vs-named duplicate pairs across 7 series and only one document
  pair actually disagrees. The remedy is library de-duplication, not loosening a matcher.

---

## 8. Coverage — six documents by four operations

Read END-TO-END: can a user's action in the ERP land in AutoCount. A cell is only as strong as its
weakest half. `PROVEN` = demonstrated against the live book. `BUILT` = code exists on both sides,
never run end-to-end. `NOTHING` = no path (the SDK merely *could* do it counts as NOTHING).

DELETE is deliberately absent: per 不可以删只可以 cancel, delete is not a capability we want.

> **The matrix that was here has been DELETED — it is generated now:**
> **`docs/generated/autocount-coverage.md`**.
>
> This copy was the most nearly right of the four that existed, and it still
> went stale in one direction that mattered: it recorded `PO CREATE` as
> **REFUSED — `FK_PO_PurchaseAgent`**, which stopped being true on 2026-08-14
> when `readPoHeader` started sending the constant `AC_PURCHASE_AGENT`. A reader
> would have concluded purchase orders still cannot be sent.
>
> The live-book evidence below is kept as a dated record of what was run that
> day. It is NOT the source of truth for what works now — that is the generated
> file, whose live-book column comes from
> `backend/scripts/data/ac-live-proof.json`.

**Five cells were PROVEN as of 2026-08-12**, all against the live `AED_HOUZS` book through the
rebuilt service, all over the tunnel or its loopback:

```
/health      -> {"ok":true,"book":"AED_HOUZS","service":"AcSyncService"}
/create-so   -> ZZERP-SO-20260812-012957, DtlKey 895100                     (4.1)
/edit  x4    -> keyless REFUSED / by-key / IsNewLine / Retire               (4.2-4.5, ZZERP-0001)
/so-to-do    -> DO-011260, 1 line   <- a REAL DO number was consumed
/cancel      -> DO then SO, both cancelled and NOT deleted
```

**`/create-po` is REFUSED on the live book** — `FK_PO_PurchaseAgent`, read out of
`C:\Temp\ac-sync-service.log`, not out of the 500. A purchase order's agent lives in
`dbo.PurchaseAgent`, a different master from the sales agent `ensure-masters` was opening. Fixed on
both sides; **the fix is not yet deployed to the host**, so PO create and `po-to-gr` remain
unproven. The full foreign-key chain and the values known to exist are in
`docs/modules/autocount-writeback.md` section 7m.

**CORRECTION, 2026-08-12.** An earlier revision of this section said AutoCount does NOT refuse to
cancel a document already transferred downstream. **That was wrong**, and it was written from a
test result rather than from the book. The service log says the opposite in as many words:

```
ERROR /cancel: AutoCount.Invoicing.TransferedDocNotAllowToCancelException:
  The document was transfered to other document, so it is not allow to cancel.
```

**AutoCount DOES refuse.** Cancel the child before the parent — which is what the teardown in
`qa-convert.ps1` already does, and why it succeeds.

The false reading came from the harness, not the book: `qa-convert.ps1`'s `Call` helper returns
`status = 0` when a `WebException` carries no `Response` object, and step 6 asserts `status >= 400`.
A genuine refusal therefore scored as a failure. The same defect made `/create-po`'s foreign-key
error read as `status=0` instead of 500. **A test whose failure path cannot tell "refused" from
"could not ask" will eventually report the world backwards** — and it did, into this document,
which is why the correction is written here rather than quietly edited out.

**The asymmetry is entirely on the ERP side.** The AutoCount service already serves more than the
ERP asks of it:

| | AcSyncService accepts | The ERP enqueues |
|---|---|---|
| `/edit` | **all six** — `SO`, `DO`, `IV`, `PO`, `GR`, `PI` (`AcSyncService.cs:440-447`) | **SO and PO only** — `enqueueEdit` is imported by `mfg-sales-orders.ts` and `mfg-purchase-orders.ts` and by no other route file |
| `/cancel` | **all six** (`AcSyncService.cs:421-426`) | **SO, PO, DO, GR** — `sales-invoices.ts` and `purchase-invoices.ts` import only `enqueueConvert` and `recordConvertSkipped` |
| `Retire: true` on an `/edit` line | yes — `Qty = 0` + `Transferable = false` + `[ERP-CANCELLED]` `Desc2` | **nothing sends it.** `scm.purchase_order_items` has no `cancelled` column at all, and no ERP route has ever written `cancelled = true` on a sales-order line |

So four of the missing cells are **two enqueue calls and a hook**, not new capability. Closing
SI/PI cancel is `S`-sized work.

**Standalone create for DO / GR / SI / PI does not exist in AutoCount by design.** Those documents
only ever come from a convert — `AddPartialTransferDetail` against the parent's still-outstanding
lines is the only transfer primitive the SDK has, and the detail classes expose no settable `From*`
fields, so the link cannot be faked. That is why those cells read `n/a by design` and not as a gap.
A DO raised in the ERP with no parent SO simply has no path, and the ERP must not pretend otherwise.

Three real caveats on convert, all from `docs/archive/autocount-sync-coverage-2026-08-11.md`:

- ~~**One source document only.**~~ **CLOSED 2026-08-18.** The limit belonged to
  `AddPartialTransferDetail`, not to AutoCount: `FullTransfer` takes an ARRAY of document numbers,
  and the service groups named keys per source and calls the primitive once each (2026-08-16).
  `enqueueConvert` now takes an array and all six ERP call sites name every source. Rows recorded
  BEFORE that date are still `skipped` and still need working by hand — nothing was composed for
  them, so no re-queue can help.
- ~~**A partial conversion becomes a full one (D14).**~~ **CLOSED.** `readConvertSourceKeys` names
  the lines the conversion actually took, and refuses when it cannot name them rather than sending
  blind. Note the second half, closed 2026-08-18 with the merge: `conversionIsPartial` compared ONE
  parent's line count against the total taken from all of them, so a MERGED partial read as
  whole-document — the same blind transfer, one level up. It counts per parent now.
- **Over-transfer is refused, silently.** Correct default, but combined with the above it means a
  conversion can fail for a reason the ERP user never sees.

And the asymmetry that has no clean answer: **the SDK has no un-cancel.** A grep of the whole
reflected surface for `uncancel`, `Cancelled:Boolean` and `set_Cancelled` returns nothing. An ERP
un-cancel cannot be pushed. Recommendation on the table for the owner: make ERP cancel irreversible
once `linked_ac_docno` is set, because it is the only option that cannot silently diverge.

---

## 9. The defects this migration found

These are the real product of the work. The last column is the point of the table: **every one was
found by measuring, not by reasoning**, and several had already survived a confident argument that
they were fine.

| # | Defect | What it did | How it was found |
|---|---|---|---|
| 1 | **jsonb double-encoding corruption** (`#1938`) | `refresh-sofa-colours.mjs` printed `APPLIED - stamped 146 sofa lines` on **three** runs. The write was not lost — it landed and destroyed the column. `JSON.stringify(patch)` bound to a `$1::jsonb` parameter is encoded twice by postgres.js; `object \|\| non-object` then **concatenates into an array** instead of merging, and `->>'key'` on an array is NULL, so the guard re-admitted the same row every run | Probe run **31416469998** read the **raw jsonb** of five lines an apply claimed to have stamped, and printed an array with one JSON string per run. The database itself then confirmed the damage by refusing `jsonb_object_keys` on those rows |
| 2 | **The `(DocNo\|itemCode)` variant collision** (`#1951`, `#1958`, `#1964`) | `refresh-so-variants.mjs` keyed its parsed-`Desc2` lookup on `${DocNo}\|${itemCode}`, which is not a line identity. An order with three lines of one SKU in different colours collapsed to one entry and the **last** row's parse was stamped onto all three. **183 keys collide, 298 lines affected** | Measured on the **checked-in export with no database access** — count the keys, count the collisions. Then md5 per line in production confirmed the `Desc2` was byte-identical on both documents, which is what killed the "commercial dispute" theory. Closure: agree **2289 to 2360**, mismatch **78 to 7**, collision-attributable **71 to 0** |
| 3 | **The write-freeze bypass granted nobody anything** (`feat/write-freeze-area-scope`) | The freeze was documented and believed to exempt the owner and `scm.admin`. It never did: with the freeze on, **every** caller was refused, including `*`. `write-freeze.ts` read `c.get('houzsUser')`, set by `supabaseAuth` which each sub-router mounts itself — but the freeze is mounted a level above, so it runs before any sub-router middleware and `perms` was always `[]`. Second dead branch: **no identity in this codebase has an `is_owner` field** | Proved by **dispatching a Hono app assembled in the production shape** and recording what the freeze could actually see. That harness is now `backend/tests/writeFreezeMiddleware.test.ts`, whose "the bypass" block fails with 503 against the old code. Nobody had reported it because the same accounts do their repairs over `DATABASE_URL`, so the hole nobody could use was the hole nobody noticed |
| 4 | **An uncompilable over-transfer handler** — still on `main` today, fix on `fix/acsync-overqty-uncompilable` | The SDK raises a WinForms dialog for over-transfer, and the service carries a handler to answer it programmatically: four `doc.ConfirmOverTransferedQtyEvent += OverQty` subscriptions (`AcSyncService.cs:316, 325, 334, 344`) and the handler at `:358`. `AutoCount.Invoicing.ConfirmOverTransferedQtyEventArgs` is **not public**, so that method cannot compile — the file on `main` does not build | Reading the reflected SDK surface rather than the documentation, while preparing the host build. Replaced by making the condition unreachable: only ever transfer what is outstanding. **A file that compiles on exactly one machine in the building gets no CI, which is why this sat undetected** |
| 5 | **`/health` reported a book it was not connected to** (same branch) | `BOOK` was a hardcoded `"AED_HOUZS"` constant, separate from the value that builds the DB connection line. A build pointed at a test book **still announced the live one** — on the single signal an operator uses to check exactly that | Found while preparing the test-book verification, at the moment the two values had to differ. Now `__BOOK__`, substituted from the same source as the connection line |
| 6 | **The SO list named no purchase order for 91% of the orders that had one** (`fix/so-list-po-and-specials-display`) | `HC-SO-011733` rendered an em-dash in the PO No. column while its own Relationship Map showed `HC-PO-008783` linked. Every row on page one showed the em-dash. The column reads `source_po_union` and **both its arms require EXECUTION**; the line-link content had been demoted to a tooltip by the previous fix for this same bug | Measured on production over all **2,723** Houzs Century sales orders: at most **53** can light either source arm, while **277** carry a real non-cancelled PO on the line link — *"blank for ~91% of the orders that have a purchase order"*. After the fix, **53 to 295**, a gain of **242**. Class lesson recorded: "the column is empty for every row on page one" is a **population** question, not a row question |
| 7 | **The amendment path repriced migrated orders** (`#1954`) | Approving **any** amendment on a migrated SO — including a quantity-only one — overwrote `unit_price_centi` with `mfg_products.sell_price_sen`, restating a historical customer price. `recomputeFromSnapshot` takes `trustOperatorSelling` as its **15th** positional parameter; `recomputeOneLine` called it with **14**, so the flag could not be passed at all | Traced by **argument count** against the three call sites that do pass it. The regression guard is behavioural: three tests drive `recomputeOneLine` through a stubbed client, and dropping the forwarded argument fails two of them — verified by reverting the line. Not yet observed in production only because the importer never sets `processing_date`, so a migrated SO is never processing-locked |
| 8 | **Editing a shipped delivery order never reached the stock ledger** (`#1957`) | An operator changes a line quantity on a DO that has already shipped. The document saves, the screen agrees, the paperwork is right — and **inventory does not move**. `resyncInventoryForDo` writes delta movements into the same `(source_doc_type, source_doc_id, product_code, variant_key)` bucket the first ship already wrote, and production carries a partial unique index on exactly that key with `movement_type` **not** in it | Measured on production, Actions run **31426819498**: **zero** movements anywhere carry the function's own notes marker — it had never landed a single row. The index (`uq_inv_mov_do_source`) is prod-only DDL that exists in **no file in this repository**. Read against the migration tree the old belief was reasonable; read against `pg_indexes` it was false |
| 9 | **Three document-level hard deletes** (`fix/po-no-hard-delete`, `fix/remove-remaining-hard-deletes`) | `DELETE /mfg-purchase-orders/:id` purged a CANCELLED PO, header and lines by cascade. `DELETE /purchase-consignment-orders/:id` did the same, and **without even the audit row**, because the module is a line-for-line clone. `DELETE /quotes/:id` purged a quote with **no status guard at all**, at any point in its life, including one already promoted to a sales order | The first by reading the code's own comment — the audit row is documented as *"the ONLY remaining evidence that the PO existed"*. **When a comment has to explain that an action destroys the only evidence of its own subject, the comment is the review finding.** The other two by the sweep that should have happened first: `docs/hard-delete-inventory.md` classifies all **70** `DELETE` handlers on the SCM surface as VIOLATION / COMPLIANT / ROLLBACK-KEEP. Three found on three separate occasions, one at a time, is the signature of ad-hoc discovery rather than an audit |

Four more, same class, same lesson:

| Defect | How it was found |
|---|---|
| **A compartment correction hard-DELETED two sales-order lines** (run 31393696809 logged `removed 2`), against the cancel-only rule which arrived after the run | Confirmed against the **database** rather than the log, because a log line is not evidence: the diagnostic prints both documents' current rows and finds no cancelled row to recover |
| **The first two cancelled SO lines ever written** would have printed on a customer PDF, and one was a column away from making `HC-SO-012624` permanently un-shippable (`409 sofa_partial_set`) | ~85 places filter on `cancelled`, but nothing had ever written it, so **no reader had ever been exercised with one**. `check-cancelled-so-line-readers.mjs` now replays each guard's own predicate against the live rows so the next person measures instead of arguing |
| **18 duplicate migrated DO lines** across 8 documents — `HC-SO-001920` ordered one item and showed four delivery lines | Diagnostic run **31431814091**, section D. They cost no stock (**0 movements**), but **11 sales-order lines read as over-delivered** |
| **The migrated DO writer copied no classification**, so the whole SO-to-DO chain leg audited an empty set and read as clean | The cross-company contrast: company 2's 41 sofa/bedframe DO lines all carry their own tag, and company 2's DO lines were not made by this writer. That is what proves the NULLs are the writer's doing and not drift |

### 9.1 Is the migrated data identical to AutoCount? No — and here is the list

The owner asked it directly on being shown the over-receipt:

> 我们的数据居然是 migrate 的，那就应该全部一模一样 migrate

He was right to. `check-migration-fidelity` (**PR #1981**) now answers it on demand, per line and
per field, against the live `AED_HOUZS` book:

```
migrated lines compared field by field against the live AED_HOUZS book : 15,295
field values that DIFFER                                               :  2,397
of those, with no already-decided reason                               :  1,765
ERP lines that could not be paired at all (each one listed)            :     33 of 15,328
```

It prints a **72-field map** — 42 COMPARED, 6 DERIVED, 21 DECLARED, 3 NOT-CHECKED — so a field the
check does not cover is *visible* rather than silently absent, and it groups findings **by field**,
so one importer bug wrong on many rows reads as one finding instead of scattered noise.

**Every finding below came from it, and none was visible to any aggregate check.** Document counts,
numbering, balances, the SO to PO to GR chain and stock status were all passing while every one of
these was true. That is the shape of the whole class: an aggregate agrees while a per-line field is
wrong.

| Finding | Detail |
|---|---|
| **The over-receipt is 130 lines, not 65** | `export-received-pos-live.py` computes `GrQty` as `SUM(GRDTL.Qty)` over `(DocNo, ItemCode)` — a document-level aggregate. On a document holding two lines of one item code (routine for sofa compartments) every line got the document's total, and `import-ac-so-linked-pos.mjs:167` wrote it into `received_qty`. **65 PO lines / 73 excess units / 29 POs, PLUS 65 migrated GRN lines that inherit the same number.** The GRN half was missed on the first pass: one wrong source produced two wrong rows, so **repairing the PO line alone would leave the GRN wrong** |
| **A misspelled export key ate 101 delivery dates** | `import-ac-outstanding-po.mjs` reads `l.DelivDate` in three places. The export column is named **`DeliveryDate`**. The read silently yields `undefined`. **101 PO lines are ERP-null against a real AutoCount date; 46 POs show no expected delivery at all.** This is the root cause of the owner's own screenshot question — *"delivery date 全部没带来？"* — and the **second** time this exact key rename has cost data, the first having lost 76 line dates |
| **AutoCount quantity 0 becomes 1** | `Math.round(num(l.Qty)) \|\| 1`. Zero is falsy in JavaScript, so a legitimate zero-quantity line is written as one. **5 lines**, plus 2 PO line totals AutoCount records as 0 |
| **321 AutoCount lines sit on a document we hold, with no ERP line at all** | The document came in; the line did not. **245** already transferred (delivered or invoiced in AutoCount), **23** zero quantity, and **42 still outstanding** — of which **26** are purchase-order lines and **24** are sofa builds on recent POs. The 42 are a real gap in what staff can see and act on. The 245 are consistent with the deliberate decision not to migrate history, but had never been enumerated, so they had never been separated from the real gap |
| **1,004 venue values the check cannot evidence** | The venue on those lines does not match AutoCount's raw value, and the check could not prove it is the post-import canonicalisation — it *could* prove exactly that for 593 others. Either the canonicalisation is under-recorded, or some venues were rewritten by something else. **Unresolved.** It needs the canonicalisation rule stated somewhere the check can read |

**This is also what the "header amount differs" findings turn out to be.** The 39 SO and 7 PO
headers flagged that way each agree with their own lines **to the cent**. Nothing is mispriced;
there is simply less of the order in the ERP than in AutoCount.

**The discipline note that produced the number, and it is the point of this whole section.** The
check's first run found **51** over-received lines, not 65. Rather than explaining the gap away, the
fault was traced to the check itself: matching a sofa build by exact item code claimed one
compartment and orphaned its siblings, hiding 14 lines. Fixed to claim a build as a group, re-run,
and it reproduced 65 exactly. **When a measurement disagrees with a measurement you trust, suspect
the new instrument before you suspect the world.**

---

## 10. What was migrated, and from which AutoCount column

Company scope is `company_id = 1` (Houzs Century). 2990 is untouched.

| | count | source |
| --- | --- | --- |
| Sales orders (outstanding) | **2,710** documents / 13,588 lines | `SO` / `SODTL` |
| Purchase orders | **407** (including 250 already received) | `PO` / `PODTL` |
| Goods receipts | **291** migrated GRNs | `GR` / `GRDTL` |
| Delivery orders | **25** migrated partial DOs | `DO` / `DODTL` |
| Stock balance | 1,020 cells / +9,679 units, later relayered into real FIFO layers | view `vItemBalQty` |
| Line photos | 983 SO + 242 PO keys in R2 | RTF `\pict` blobs carved out of the AutoCount description |

**Deliberately NOT migrated**, each a decision rather than a gap:

- **Historical IV / DO / PI documents** (9,783 / 11,134 / 5,120). Owner: *"这个不要"*.
- **Whole-sofa stock balances.** Owner: *"沙发库存不准的，因为我们接下来跑 compartment 了 …
  pillow 就 ok"*. AutoCount counts one whole sofa; the ERP counts its compartments, so a balance row
  cannot be decomposed without inventing which build it is. Sofa **pillows** are ordinary
  accessories and did come in.

Every migrated document carries AutoCount's own number, prefixed `HC-`. A GRN whose AutoCount
receipt spans several POs also carries the PO (`HC-GR-000201-PO-000596`).
`scm.grns` and `scm.delivery_orders` carry `migrated_no_stock boolean` (migration `0276`): those
documents hold quantities and links but create **no inventory movement**, because the balance
snapshot already counted the goods. The corollary bites in practice — **a migrated GRN creates no
FIFO layer**, so writing a cost onto a migrated PO or GRN line is inert (section 11).

### The field map

Anything not on this list was not migrated. If a field matters and is missing here, that is a gap,
not an omission from the document.

| ERP field | AutoCount source | note |
| --- | --- | --- |
| document number | `DocNo` | prefixed `HC-` |
| customer / supplier | `DebtorCode` / `CreditorCode` + name | |
| document date | `DocDate` | |
| line item code | `ItemCode` to ERP `material_code` | via the mapping CSV; **not invertible for sofa** |
| line description | `Description` / `Desc2` | `Desc2` carries the build: fabric, size, legs, gap |
| quantity | `Qty` | |
| unit price (SO) | `UnitPrice` | |
| unit price (PO) | `UnitPrice` — **null on 565 of 579 imported lines, and on 126 of 126 sofa lines** | faithful: AutoCount prices sofas on the purchase invoice, not the PO |
| **received quantity** | **`PODTL.TransferedQty`** | NEVER the export's `GrQty` — see section 12 |
| PO to SO dedication | `PODTL.FromSODtlKey` | never a zip or a sibling match |
| line identity | `DtlKey` to `linked_ac_dtlkey` | a WRONG key is worse than NULL: NULL means "refuse", a wrong one silently edits a different line |
| stock status | `SO.Remark2` | `nvarchar(40)` on the header; the ERP mapping is an identity mapping |
| the PO raised for an order | `SO.UDF_ToPONo` | **comma-joined** when one SO became several POs — compare as a SET |
| outstanding balance | `SO.UDF_BALANCE` | |
| delivery date | `DeliveryDate` | **not** `DelivDate` — an earlier export key rename silently lost 76 line dates |
| **unit cost** | **`PIDTL.UnitPrice`**, reached PO to GR to PI | section 11 |
| stock on hand | `vItemBalQty` | per item and location |

### AutoCount has no line-to-line keys

This is the single most important structural fact about the whole migration.

```
PIDTL.FromDocDtlKey populated:  0 of 20,777
GRDTL.FromDocDtlKey populated:  0 of 21,000
```

AutoCount records only the **document** a line came from, never the line. Every line-to-line link
in the ERP is therefore a **reconstruction**, joined on `(document number, ItemCode, Desc2)`. That
reconstruction is where every wrong-value incident in section 3.1 came from, and it is why a key
that omits the item code pulls a different bed size's price.

`linked_ac_dtlkey` is the first time those links are pinned down:

```
SO lines: 12,910 of 13,907 set;  972 no AutoCount match;  25 skipped as ambiguous
PO lines:    275 of    864 set;  589 no AutoCount match
```

The 589 are the sofa problem in disguise: the backfill matches on `(DocNo, ERP code)` and a
decomposed sofa line stores a **compartment** SKU (`DSL-8030-1A(LHF)`) that no AutoCount ItemCode
maps to.

---

## 11. Costing

The pipeline is: document price -> FX and freight -> `inventory_movements.unit_cost_sen` ->
`inventory_lots` -> `inventory_lot_consumptions` -> DO line -> SI line. There is no COGS
general-ledger account. The mechanism is one AFTER INSERT trigger on `inventory_movements`:

- **IN** opens one lot at `COALESCE(unit_cost_sen, 0)` — floored at zero, no average fallback.
- **OUT** consumes lots in `received_at ASC, id ASC`, exact dye lot first (`fn_consume_fifo_batch`)
  then plain product and variant (`fn_consume_fifo`), writing the consumption rows that ARE the COGS.
- **positive ADJUSTMENT** opens a lot at `COALESCE(NULLIF(cost,0), average_of_open_lots, 0)` — the
  average fallback exists only on this branch.

**The trap: writing a cost onto a migrated PO or GRN line is INERT.**
`inventory_lots.unit_cost_sen` — the valuation column — has exactly **one** writer in the entire
backend (`backend/src/scm/lib/recost.ts:417`). A migrated GRN posts no movement, so it opens no lot.
The migrated stock lives in lots minted by the balance snapshot as positive `ADJUSTMENT` movements
(`source_doc_type = 'AC_CUTOVER'`). So "read the invoice price and stamp it on the PO line" writes a
number nothing downstream reads. **The cost has to go on the lot.**

The invoice is where the price is, measured live and read-only:

```
PI lines: 21,927 total, 19,918 priced (90.9%)
PO lines with NO price: 10,371 -> the PI down the chain carries a price for 9,863 (95.1%)
the chain is PO -> GR -> PI:  PIDTL.FromDocType = 'GR' on 20,777 of 21,927 lines
```

Validated against the known-good subset — PO lines that already had a price: **5,665** such lines
have a PI price, the PI agrees with the PO on **5,603 (98.9%)** and differs on **61 (1.1%)**. Those
are price changes between order and invoice, and for costing the invoice is the truth because it is
what was actually paid.

For contrast, the inference approaches backtested over 11,239 priced purchase lines and **rejected**:

| method | exact | MAPE | overstates |
| --- | ---: | ---: | ---: |
| `MAX(UnitPrice)` by item code | 2.1% | 112.5% | 97.6% |
| LAST purchase cost by item code | 9.7% | 32.2% | 57.2% |
| item + `Desc2` signature | 97.3% | 0.4% | 1.5% |
| supplier + item + `Desc2` | 98.0% | 0.4% | — |

**Applied to production 2026-08-11** — `backfill-zero-cost-lots`, APPLY run **31458214535**. It
touches only lots from this cutover, still fully unconsumed (so no settled COGS is rewritten), and
currently zero-cost; the originating movement is updated in the same transaction so the lot and the
ledger never disagree.

```
to cost                          : 103 lots /  396 units,  +RM 69,812.18 of inventory value
left at zero on purpose          : 127 lots /  216 units  (GWP / demo / display - zero IS their cost)
skipped because already shipped  :   0
```

Independently re-measured afterwards by `stock-truth-check`, **not** by the script's own log:
zero-cost open layers **230 layers / 612 units to 127 layers / 216 units**; inventory value
**RM 2,158,598 to RM 2,228,410**. The 127 that remain are 89 sofa layers waiting on the compartment
round and 38 genuinely free items.

**Caveat, stated plainly:** this backfill priced from *the item's most recent priced purchase*, which
is an inference (9.7% exact in the table above), not a copy. It was applied on the owner's explicit
instruction after that was pointed out. Snapshot lots have no invoice of their own to copy — but
where a relayered lot does trace to a real receipt, upgrading it to that receipt's actual invoice
price is strictly better and is still open.

---

## 12. What is left — owner, IT, code

### Needs the owner

| # | Decision |
|---|---|
| 1 | **The go/no-go on lifting the freeze.** Nobody lifts without him: *"解冻我跟你说你才做."* |
| 2 | **Apply the four pure-loss repairs?** (section 9.1, runbook step 0d.) 130 lines carry a received quantity AutoCount never recorded — **AutoCount does not permit an over-receipt; we manufactured this** — plus 101 lost delivery dates, 5 zero quantities written as 1, and 42 outstanding lines that never arrived. Every one is a copy of a value AutoCount already holds, none touches a stock movement. Written, not applied |
| 3 | **Is an ERP cancel irreversible once `linked_ac_docno` is set?** The SDK has no un-cancel. Recommendation: yes, because it is the only option that cannot silently diverge |
| 4 | **Should the ERP charge for special add-ons at all?** AutoCount never did — it absorbed them into the negotiated line price. Today a priced SOFA add-on is **costed but never charged**, so it only reduces margin |
| 5 | **Fabric library merges** — `03#Straw` (HIRRING GD8371-03 or HIVE GD2034-03?), `J9833-2` (mistyped `J9883-2 CHIC`?), `Beetex harring gd 8371` (which of 10?), `ZanoLeather` (which ZL?), `GD8371` vs `HIRRING GD8371`, and whether to merge the 32 duplicate series |
| 6 | **`HYDRAULIC`** — a divan property with no home. A bedframe variant axis, a flag in the item code like ADJUSTABLE, or free text? It must not become a `special_addons` code |
| 7 | **"Seat Softer"** (7 instances), the direct opposite of the existing `Seat Firmer`, currently with nowhere to go. Create it? |
| 8 | **`HC-SO-012949`** — a customer ordered a super-single `CODY-(S)` that was never put on any purchase order. Raising it is a commercial act |
| 9 | **The 27 held-back specials lines** keep their instructions as free text with no picker tick, matching his own fallback rule. Accept, or build migrated-immunity in the money path? |
| 10 | **AutoCount physical negatives** — `AK-SK FX AIRLOFT PIL` KL (-10), `CH-DC` KL (-12), `AK-CS AIRLOFT COMFY PIL` C&C DISP (-6) and a handful more. Recommendation: treat the ERP value as authoritative at go-live and book the difference as a counted stock-take variance |
| 11 | **Two HELD sofa compartment corrections** — `HC-PO-010056 / HC-SO-012696`, and `HC-PO-000162` where `5526` must first become its own model |
| 12 | **Three sofa compartment corrections refused because the money would move** — `HC-PO-009597`, `HC-PO-010117` (as `HC-PO-000254`) and `HC-PO-010023` (as `HC-PO-008783`). Each is a migrated PO whose header total is **0** while the sofa line still carries a `unit_price_sen`, so putting the build's price on its first piece would take the document from 0 to 383,200 / 431,700 / 421,500 sen. The refusal is the money guard working, not a matcher miss — the builds themselves now match (`fix/sofa-desc2-matcher`, bug 0637). `HC-PO-009597`'s sales order `HC-SO-012828` DID apply, and its single PO line follows the SO line it is dedicated to, so the PO reads `1A(LHF)` of a five-piece build. **Owner decision:** correct the PO lines to zero-priced pieces (paperwork only, the header total is already 0 and stock came in with the balance snapshot), or leave all three as they are |

### Needs IT at the office

| # | Task |
|---|---|
| 1 | ~~Stand up the tunnel route~~ **DONE 2026-08-11.** `autocount.houzscentury.com` fronts `localhost:8900`; the owner changed it in the Cloudflare dashboard, which is where a token-mode cloudflared keeps its ingress — **no physical presence was needed after all**. `AC_SYNC_URL` and the `AC_SYNC_KEY` secret are both set. See Step 3 |
| 2 | Set `AC_SYNC_URL` in `backend/wrangler.toml` and `wrangler secret put AC_SYNC_KEY`, matching `C:\Temp\ac-svc-key.txt` |
| 3 | Rebuild the clean service from the bridge and confirm `/health` names the book it is connected to (runbook step 1) |
| 4 | Restore or replace `AED_TESTING`, if a test book is ever wanted again. The current one has exhausted its 500-transaction evaluation limit |

### Needs code

| # | Work | Size |
|---|---|---|
| 1 | **Alarm and backlog monitor.** Raise `MAX_ATTEMPTS`, add real backoff, and add a scheduled check that alarms on `failed > 0` or oldest `pending` older than N minutes. **The queue without this is a queue nobody reads** | M |
| 2 | **Per-document sync state** — `sync_status` / `sync_error` / `synced_at` on each document header, surfaced as a badge. It makes the whole failure class visible to the people best placed to notice, and it costs one migration | M |
| 3 | **Close D10 and D9** — the sofa item code is not invertible (589 of 864 PO lines cannot be matched back), and a sofa does not collapse to one AutoCount line. **Until these are closed, no document carrying a sofa can be written back at all** | M |
| 4 | **Close D6** — `/edit` must apply `ItemCode` on a `DtlKey`-addressed line, or a SKU swap (`tbc-swap`) leaves the old product in AutoCount with a new price | S |
| 5 | **Close D14** before enabling any convert — send `DtlKeys` so a partial conversion does not become a full one | M |
| 6 | **Line retirement, ERP side.** SO lines have a `cancelled` column and no writer; PO lines have **no column at all**. Three PRs, in order: SO readers, then the PO migration and its ~80 readers, then send `Retire: true`. `docs/autocount-line-retirement-plan.md` has the gap list | M |
| 7 | **SI / PI cancel hooks** — two `enqueueCancel` calls. The service already serves them | S |
| 8 | **DO / GR / SI / PI edit hooks** | M |
| 9 | **Drift detection** — extend `check-autocount-parity.mjs` into a field-level diff over documents with `linked_ac_docno IS NOT NULL`. Detect from day one; lock AutoCount by permission only after the ERP path has been trusted for a couple of weeks | M |
| 10 | **Cross-system doc-number collision detector.** The two series cannot collide today only because the formats happen to differ (`SO-2608-001` vs `SO-000021`) — nothing enforces it, and supplying our own `DocNo` does not advance AutoCount's counter | S |
| 11 | **State the venue canonicalisation rule somewhere `check-migration-fidelity` can read it**, so the 1,004 unevidenced venue values resolve one way or the other. Today the check can prove the rule for 593 lines and not for 1,004, which is not an answer | S |
| 12 | Smaller, all real: **382 PO lines with no `so_item_id`** (the over-ship and over-receive ceilings are keyed on that link, so they are blind to unlinked lines — this is why `DO-2607-005` on `SO-2606-019` double-shipped); **46 migrated DO lines with no price or cost**; a genuine FIFO short is computed and never persisted; SO photo routes apply no company scoping while the PO and consignment routes do | |

---

## 13. Companion documents

| Document | What it owns |
|---|---|
| `docs/generated/autocount-coverage.md` | the generated coverage table. The 2026-08-12 handoff snapshot it replaced is archived at `docs/archive/AUTOCOUNT-GOLIVE-HANDOFF-2026-08-12.md` |
| `docs/autocount-cutover-ledger.md` | the chronological run log, W0 to W18, every run id |
| `docs/golive-readiness.md` | the write freeze, whether the write path is trustworthy, the risk register |
| `docs/archive/autocount-sync-coverage-2026-08-11.md` | the coverage matrix in full, the divergence register D1-D14, the build plan |
| `docs/autocount-service-deploy.md` | build and deploy on the AutoCount host; the `Retire: true` contract; runbook 4.1-4.6 |
| `docs/autocount-line-retirement-plan.md` | what has to change before a line can be cancelled instead of deleted |
| `docs/write-freeze-staged-lift.md` | the freeze grammar, the area table, the staged lift, the rollback |
| `docs/stock-reconciliation.md` | criterion 3 in full — both axes, every named cause. **The per-warehouse close is in PR #1947, not yet on `main`** |
| `docs/sofa-document-chain-map.md` | criterion 2 — the four chain legs, per company |
| `docs/modules/autocount-writeback.md` | the write-back module guide |
| `docs/jsonb-double-encoding-coe.md` | defect 1, as a COE |
| `docs/hard-delete-inventory.md` | all 70 SCM `DELETE` handlers, classified |
| `docs/migrated-do-duplicate-lines.md` | the 18 duplicate migrated DO lines |
| `docs/duplicate-fabric-series-merge.md` | the fabric library duplicates behind owner decision 5 |
| `BUG-HISTORY.md` | the per-bug ledger. The most recent entries are this migration |
| `backend/scripts/check-migration-fidelity.mjs` (**PR #1981**) | the per-line, per-field comparison against the live book. Section 9.1 is its output; run it before you repair anything |

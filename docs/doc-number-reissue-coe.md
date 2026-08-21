# COE — the document counter re-issued numbers the account book already held

**Date** 2026-08-20 · **Status** FIXED 2026-08-21 — option B shipped as
`scm.doc_number_counters` (migration 0316), branch `fix/doc-no-counter-table`,
bug ledger entry 0489 · **Area** SCM document numbering, AutoCount write-back

---

## 老板版摘要（先看这段）

**最重要的一件事，先回答：ERP 里面没有两张单共用同一个号码。** 全部 41 个「单据
号码」栏位都有数据库的唯一索引挡着，重复根本存不进去。这一点是跑了生产数据库量出
来的，不是推论。

**真正发生的事**：08-20 早上做上线清空（go-live wipe），把 Houzs Century 的旧单据
全删了。我们的号码是「看现有单据的最大号 + 1」算出来的 —— 单据被删光，最大号就回到
0，下一张单又从 001 开始。于是 08-14/17 已经写进 AutoCount 账本的
`HC-SO-2608-001`、`HC-SO-2608-002`、`HC-PO-2608-001` 被 ERP 再发了一次，AutoCount
说「这个号码已经有人用了」（Primary Key Error）—— 它是对的。

**比原本以为的多两件事**：

1. 还有第四张单 `HC-PI-2608-001`（采购发票）也是重复号码，只是它卡在别的原因上没
   送出去，所以没出现在那四张「被拒绝」的名单里。
2. `HC-DO-2608-001`、`HC-DO-2608-002`、`HC-SI-2608-001` 这三个号码账本已经有了，但
   ERP 这边是空的 —— 也就是说，**这个月下一张 HC 交货单和下一张 HC 销售发票一开，
   就会再撞一次**。现在还没炸，但已经上膛了。

**为什么会一直重演**：清空脚本连 `scm.autocount_outbox`（ERP 唯一记得「我送过什么
出去」的地方）也一起删了。所以 ERP 现在完全不知道自己送过那些号码 —— 账本是唯一还
记得的一方。只要再清空一次，同样的事会再发生一次。

**要怎么根治**：市面上的 ERP（AutoCount、SAP、Odoo、NetSuite）全部都是「存一个计数
器，只往上加，不回头看现有单据」。删掉单据不会把号码还回来，中间断号是正常的、可接
受的。我们是唯一一个「从现有单据倒推号码」的做法，这就是差别所在。下面 §6 给三个方
案，我建议 **方案 B（计数器表）**。

---

## 1. What staff and the owner actually saw

The AutoCount Sync page showed four documents refused by the account book with
three words: `Primary Key Error`. Nothing on the page explained that the number
itself was the problem, or that the ERP had handed out the same number twice.

## 2. Root cause, traced

### 2.1 The minter derives the number from surviving rows

`backend/src/scm/lib/doc-no.ts:18-29` — `nextMonthlyDocNo(monthPrefix, existing)`
scans the doc numbers that exist for the month and returns `max(suffix) + 1`.
`fetchMonthlyDocNos` (`:65`) is what supplies `existing`, by paging
`WHERE <col> LIKE '<prefix>-%'` over the live table. `mintMonthlyDocNo` (`:90`)
is the two together, and it is the whole counter. **There is no sequence, no
counter table, and no record of numbers previously issued.** The rows that
survive ARE the counter.

The file's own header anticipates one deletion shape and not the other:

> *"Deleting a mid-month row (create rollbacks, data cleanups) leaves a gap, so
> count+1 eventually re-mints a surviving number … max+1 self-heals"*

That is correct for a gap in the MIDDLE. It does not hold for a deletion at the
TOP of the series: removing the highest-numbered document lowers the max, and the
next mint returns a number that was previously issued. Nothing anywhere records
that it was issued, so nothing can detect it.

### 2.2 The go-live wipe removes the top of every series — on purpose

`backend/scripts/golive-wipe-hc.mjs` states the mechanism in its own header,
under the heading **"DOCUMENT NUMBERS: THERE IS NO COUNTER TO RESET"**:

> *"running numbers (HC-SO-2608-001, …) are minted as max(suffix)+1 over the rows
> that already exist for the month — there is NO sequence table and NO
> per-company counter row anywhere. So deleting HC's document rows IS the reset:
> with zero surviving HC rows in a month, the next mint reads max=0 and hands out
> 001."*

Its Chinese summary says the same to the owner: 「把 HC 的单据号码归零回 001」.

**This is not a bug in the wipe.** Resetting the numbering is what a go-live wipe
is FOR, and it is documented, gated behind `MODE=apply` + a confirmation phrase,
and it takes a backup. The defect is that the ERP's counter has no knowledge of a
second namespace — the AED_HOUZS account book — which is not wiped and which
permanently holds every number the ERP ever exported to it.

### 2.3 The wipe also erased the ERP's memory of what it had exported

`golive-wipe-hc.mjs:185` puts `scm.autocount_outbox` on the CLEAR list. The
outbox is the only place the ERP records that a document reached the book.
Deleting it is why the queue could truthfully report `sentBefore=0` for numbers
the book demonstrably already held: **after the wipe, AutoCount is the only party
that still remembers.**

### 2.3a The backup that would have saved the evidence was never uploaded

The wipe dumps every CLEAR row to a backup directory BEFORE it deletes, and
`golive-wipe-hc.yml` uploaded it with `if: mode == 'apply'` and no `always()`.
A step failure skips a later step, so **the run that most needs its backup
uploaded is the one that fails.**

Run 32357340470 — the only run that actually deleted anything (§2.4) — dumped
30 `scm.autocount_outbox` rows to the runner, deleted 35,328 HC rows, committed,
then failed its verification. `gh api .../runs/32357340470/artifacts` returns an
EMPTY list. The rolled-back apply before it lost its dump the same way.

The one artifact that does exist is from run 32358148080, the no-op apply
afterwards, and its `_manifest.json` reads `"scm.autocount_outbox": 0` with a
2-byte `[]` file — which is indistinguishable from "there was nothing to back
up". **So the ERP's record of what it had exported is unrecoverable**, and
`ac-live-proof.json` is the only surviving evidence of the numbers the account
book holds. That is the whole reason migration 0316's seed has a hardcoded part.

Fixed in the same PR: `if: ${{ always() && ... }}`, and the artifact named per
run+attempt so a failed apply's dump cannot be confused with a later one's.

### 2.4 The wipe ran, in production, before the documents were raised

> **CORRECTED 2026-08-21.** This section said the wipe *"ran in production with
> `MODE=apply` twelve times"*, and the bug-ledger entry repeated it. Twelve runs
> is right; twelve APPLIES is not. Re-measured per run from the step names,
> which the plan and apply paths give different labels
> (`gh api repos/Houzs-Century/Houzs-ERP/actions/runs/<id>/jobs`):
>
> | runs | mode | outcome |
> | --- | --- | --- |
> | 8 | plan | read-only, wrote nothing |
> | 2 | — | cancelled before the step ran |
> | 32355449066 | **apply** | FK error, rolled back, **nothing deleted** |
> | 32357340470 | **apply** | **deleted 35,328 HC rows and COMMITTED**, then failed its post-commit verification |
> | 32358148080 | **apply** | found everything already 0; a no-op that passed |
>
> So exactly ONE run destroyed data — 32357340470 at 10:07 UTC — and it is the
> one that exited 1. The correction matters because it names which run to fetch
> the backup from, and that turns out to be the run whose backup was thrown
> away (§2.3a). "Twelve applies" came from counting dispatches instead of
> reading them.

`gh run list --workflow=golive-wipe-hc.yml` — twelve `workflow_dispatch` runs on
2026-08-20 between **09:03 and 10:16 UTC**. Run 32358148080's log confirms the
mode:

```
MODE: apply
CONFIRM: WIPE HOUZS-CENTURY TRANSACTIONS
mode=APPLY
HC (to wipe): id=1 code=HOUZS name=Houzs Century
```

The four documents were raised at **12:27, 12:31, 12:37 and 14:27 UTC** — after
every one of those runs.

### 2.5 It is not transactional, and that is a second, smaller hole

Two concurrent creates in the same month both read the same max and mint the same
suffix. The loser hits the unique index (23505) and `insertWithDocNoRetry`
(`doc-no.ts:117`) re-mints from a fresh read, up to 8 times. So the race is
HANDLED — but only because the unique index exists to catch it. The retry is the
safety net for the race; there is no safety net for the re-issue, because a
re-issued number does not collide with anything in the ERP.

## 3. Measured on production — read-only

Script `backend/scripts/check-doc-no-reissue.mjs`, dispatched via
`workflow_dispatch` using `secrets.DATABASE_URL`. Runs **32392865876** (crashed
in section D on a table with no `id` column — the finding is recorded in the
script's comment) and **32393349778** (complete). Permanent workflow:
`.github/workflows/doc-no-integrity.yml`.

### Q1 — do two ERP documents share a number? **NO. PROVEN.**

```
41 IDENTITY doc-number column(s) (a minter owns it, or the DB enforces it unique).
Q1 ANSWER: NO. No two ERP documents share a document number.
           Zero duplicates on any identity column.
Every column a minter owns is backed by a full unique index, so a collision cannot commit.
```

Every minter-owned column carries a full, non-partial, valid single-column unique
index — read from `pg_index` on the live database, not from the migration files.
A duplicate cannot be committed on any of them.

Six columns DO repeat a number and all six are REFERENCE columns, where repeating
the parent's number is the schema working as designed:
`public.assr_cases.doc_no` (a service case names the SO it is about),
`public.purchase_orders.doc_no`, `scm.autocount_outbox.doc_no` (one queue row per
attempt), `scm.mfg_sales_order_items.doc_no` (one row per line),
`scm.mfg_so_item_deletions.doc_no` and `scm.mfg_so_status_changes.doc_no` (audit
rows). The census reports these separately for exactly this reason.

### Q2 — was a number re-issued? **YES, four of them. PROVEN.**

An ERP row created AFTER the date the book received the same number:

| number | book has it since | ERP row created | ERP status |
| --- | --- | --- | --- |
| `HC-SO-2608-001` | 2026-08-14 | 2026-08-20T12:37:16Z | CONFIRMED |
| `HC-SO-2608-002` | 2026-08-14 | 2026-08-20T14:27:16Z | CONFIRMED |
| `HC-PO-2608-001` | 2026-08-17 | 2026-08-20T12:27:27Z | RECEIVED |
| **`HC-PI-2608-001`** | 2026-08-17 | 2026-08-20T12:31:55Z | POSTED |

`HC-PI-2608-001` is a **fifth exposed document that the outbox report does not
show**. Its queue row is `skipped` (reason: raised with no source GRN to transfer
from), not `failed`, so it never appeared in the list of rejections — but the
number is re-issued all the same, and it would be refused the moment that
document is ever sent.

### Q2b — three more are armed and have not fired yet

| number | book has it since | ERP table | ERP row? |
| --- | --- | --- | --- |
| `HC-DO-2608-001` | 2026-08-17 | `scm.delivery_orders` | none |
| `HC-DO-2608-002` | 2026-08-17 | `scm.delivery_orders` | none |
| `HC-SI-2608-001` | 2026-08-17 | `scm.sales_invoices` | none |

The ERP holds no HC 2608 row in either table, so those series are back at max=0.
**The next HC delivery order and the next HC sales invoice raised this month will
mint those exact numbers and be refused.** Nothing currently warns anyone.

`HC-GR-2608-001` is NOT in this list: our GRN minter writes `HC-GRN-…`
(`scm.grns.grn_number`, live outbox row `HC-GRN-2608-001`), while the book's
`HC-GR-2608-001` came from a hand-driven host session per
`backend/scripts/data/ac-live-proof.json`. Different strings, so no collision —
but note this is a naming divergence worth its own look, and it is UNKNOWN
whether the host derives one from the other.

### Q2c — the outbox no longer remembers anything from before the wipe

```
outbox total rows=6; rows created before 2026-08-20=0
```

**PROVEN**: the ERP retains no record of any export predating the wipe.

## 4. Blast radius — which document types and which companies

**Every monthly document type in the system shares this minter.** Enumerated from
the `mintMonthlyDocNo` call sites in `backend/src/scm/routes/`:

| type | table.column | route |
| --- | --- | --- |
| SO | `scm.mfg_sales_orders.doc_no` | `mfg-sales-orders.ts:1024` |
| PO | `scm.purchase_orders.po_number` | `mfg-purchase-orders.ts:1215` |
| DO | `scm.delivery_orders.do_number` | `delivery-orders-mfg.ts:390` |
| GRN | `scm.grns.grn_number` | `grns.ts:1834` |
| PI | `scm.purchase_invoices.invoice_number` | `purchase-invoices.ts:82` |
| SI | `scm.sales_invoices.invoice_number` | `sales-invoices.ts:270` |
| PV | `scm.payment_vouchers.pv_number` | `payment-vouchers.ts:106` |
| DR | `scm.delivery_returns.return_number` | `delivery-returns.ts:109` |
| PRT | `scm.purchase_returns.return_number` | `purchase-returns.ts:67` |
| STK | `scm.stock_takes.take_no` | `stock-takes.ts:110` |
| ST | `scm.stock_transfers.transfer_no` | `stock-transfers.ts:61` |
| CS / CN / CRN | consignment sales side | `consignment-orders.ts:200`, `consignment-notes.ts:168`, `consignment-returns.ts:116` |
| PCO / PCT / PCR | purchase consignment | `purchase-consignment-orders.ts:342`, `purchase-consignment-returns.ts:231`, `purchase-consignment-receives.ts:824` |
| TRIP | `scm.trips.trip_no` | `trips.ts:101`, `delivery-planning.ts:2222` — **cross-company, one shared sequence, no company prefix** |
| JE | `scm.journal_entries.je_no` | `doc-no.ts:203` `nextJeNo` — a separate 4-pad minter, `.order().limit(1)` rather than a paged max, **same re-issue exposure** |

**The AutoCount queue only ever showed SO and PO because those are the only
operations that have ever been enqueued — that is not evidence the others are
safe, and the census proves it: PI was re-issued too.**

Which are exposed, and how I know:

- **Exposed to a re-issue by a delete: ALL of them.** They share
  `mintMonthlyDocNo`, whose only input is the surviving rows. `nextJeNo` is a
  separate function with the same property. PROVEN by reading the single shared
  code path plus the enumerated call sites above.
- **Exposed to a COLLISION WITH AUTOCOUNT: only the types that reach the book** —
  SO, PO, DO, SI, GRN, PI (`ac-live-proof.json` records all six under the ERP's
  own numbers). PV, STK, ST, DR, PRT, consignment, TRIP and JE are ERP-only
  today, so a re-issue there is an internal numbering problem, not an account-book
  divergence. That is a statement about TODAY's integration scope, and it stops
  being true the moment another type is enqueued.
- **Both companies use the same minter.** HOUZS mints `HC-`, 2990 mints `2990-`
  (`scm/lib/companyScope.ts:508-551`), and the prefix is folded into both the
  LIKE and the max, so the two companies cannot collide with each other. **2990
  was not wiped** (`golive-wipe-hc.mjs` asserts the target is not the 2990
  company and rolls back if any 2990 row count moves), so 2990's series are
  intact — but 2990 is exposed to the identical failure if anything ever deletes
  the top of one of its months.
- **TRIP is the one series with NO company prefix**, so it is a single shared
  sequence across both companies. A wipe of one company's trips lowers the max
  for both.

## 5. What the audit RULED OUT

- **Two live ERP documents sharing a number — REFUTED, and this was the first
  question asked.** Zero duplicates on all 41 identity columns, all of which the
  database enforces unique.
- **The `HC-` prefix being stripped in transit — REFUTED** (already established
  before this audit; recorded here so it is not re-chased). The outbox sends the
  ERP number verbatim; `migratedInvoiceNumber` in `migrated-chain.test.ts` ADDS
  the prefix on import, which is the opposite direction.
- **A master-record collision — REFUTED.** `EnsureMasters` guards every insert
  with an existence check.
- **The unique indexes being absent — REFUTED.** Read from `pg_index` on
  production, not from migration files. This repo has been wrong in both
  directions on that exact question before, which is why the census reads the
  live catalogue.
- **A concurrency race being the cause — REFUTED as the cause of THIS incident.**
  The race is real and handled (`insertWithDocNoRetry`, 8 attempts on 23505). It
  cannot produce a number that collides only with AutoCount, because a raced
  number collides in the ERP first and is retried away.
- **`created_at` inversions being proof of re-issue — REJECTED as evidence.** The
  census found 95, almost all on line/audit tables where a later edit legitimately
  creates a new row under an older document. Reported, deliberately not treated as
  proof.

## 6. Options — the owner chooses

### What a normal ERP does

Every mainstream ERP stores a COUNTER and never derives the next number from the
documents that happen to exist:

| system | mechanism | does deleting return the number? |
| --- | --- | --- |
| **AutoCount** | running-number maintenance per document type — a stored "next number" the system increments | No |
| **SAP** | number ranges (`NRIV`), `NUMBER_GET_NEXT`, buffered per range object and year | No |
| **Odoo** | `ir.sequence` with `number_next_actual`, optional monthly/yearly sub-sequences | No |
| **NetSuite** | auto-generated numbering with a stored next-number per type/subsidiary | No |

All four accept GAPS as normal and unremarkable. **Ours is the only one that
re-derives the number from surviving rows, and that is precisely the difference
that caused this.** A gap is cosmetic; a re-issue is a data conflict — we
currently trade the harmless one away to get the harmful one.

### Option A — advance the counter past the book (STOPGAP)

**What changes.** Nothing in the code. Raise the ERP's series past the account
book's high-water mark once — the remedy already pending on the owner's desk for
the four stuck documents — then re-raise them.

**Cost.** Hours. No migration, no code.
**Documents already raised.** The four keep their content and get new numbers.
**Living with it.** **It does not fix anything.** The very next go-live wipe, test
cleanup or top-of-month delete re-creates the identical situation, and nothing
detects it until AutoCount refuses a document. It also does not cover
`HC-DO-2608-001/002` or `HC-SI-2608-001`, which are already armed.
**Composes with:** it IS the pending decision. Every option below composes with
it rather than replacing it — do this to clear today, then choose B or C so it
does not recur.

### Option B — a counter table (PROPER — RECOMMENDED)

**What changes.** Add `scm.doc_number_counters (company_id, doc_type, yymm,
next_n)` and mint with a single atomic statement:

```sql
INSERT INTO scm.doc_number_counters AS c (company_id, doc_type, yymm, next_n)
VALUES ($1, $2, $3, 2)
ON CONFLICT (company_id, doc_type, yymm)
DO UPDATE SET next_n = c.next_n + 1
RETURNING next_n - 1 AS n;
```

Seed it per series from `max(existing)` AND from the account book's high-water
mark, whichever is higher. Change `mintMonthlyDocNo` itself, so its 29 call
sites inherit it without being touched (`git grep -n "mintMonthlyDocNo(" --
backend/src` — 30 lines, one of which is the definition). Keep the unique indexes and
`insertWithDocNoRetry` as the safety net.

**Cost.** One migration plus one function. Roughly a day including the seed
script and tests. The risk concentrates in the SEED — a series seeded too low
collides on first use, which is why it seeds from the higher of the two sources
and why the retry loop stays.
**Documents already raised.** Untouched. Their numbers stand.
**Living with it.** Deleting a document no longer returns its number. Gaps
appear, as they do in AutoCount, SAP, Odoo and NetSuite. The go-live wipe must
then be given an EXPLICIT counter reset (a new input) rather than resetting by
side effect — which is better, because the reset becomes a decision someone makes
rather than a consequence nobody sees.
**Composes with:** run Option A first to clear today; B makes it permanent.

### Option C — an append-only issued-number ledger (MIDDLE)

**What changes.** Add `scm.doc_number_issued (doc_no PRIMARY KEY, issued_at,
company_id, doc_type)`, written whenever a number is minted, never deleted. Keep
`max+1` but take the max over the UNION of live rows and this ledger.

**Cost.** One migration plus a small change in `mintMonthlyDocNo`. Less than B.
**Documents already raised.** Untouched.
**Living with it.** Preserves the current shape, so it is the smallest diff that
actually closes the hole, and it leaves an audit trail of every number ever
issued — genuinely useful for the AutoCount reconciliation. But it is still a
`MAX()` scan on every create (the 1000-row PostgREST truncation trap documented at
`doc-no.ts:31-64` still applies, now over two sources), still needs the retry
loop, and it adds a table whose only job is to remember what a counter would
simply know. **It must also be excluded from the wipe's CLEAR list, or it is
wiped along with everything else and buys nothing** — which is the same trap that
took out the outbox.

### DECIDED — Option B shipped 2026-08-21 (A absorbed into its seed)

The owner approved *"advance the counter past the book, then move to a real
counter"*, and those collapse into ONE change: the counter table is SEEDED above
both the surviving ERP rows and the numbers the book is evidenced to hold, so
the seed performs the advance. There was no separate step A.

**What shipped** — migration 0316, `scm.doc_number_counters` +
`scm.next_doc_no_n(series, floor)`, changed inside `mintMonthlyDocNo` so all 29
call sites inherit it, and inside `nextJeNo` for the 4-pad JE series. The live
scan stays as a FLOOR (`GREATEST(counter, floor + 1)`), which self-seeds any
series the migration never covered and makes the 1000-row PostgREST truncation
trap unable to cause a re-issue. Full detail in bug ledger entry 0489.

**The seed, with a source per value.** Measured read-only on production BEFORE
it was written (run 32454881949, section G):

| series | next number | where that number comes from |
| --- | --- | --- |
| `HC-SO-2608` | 3 | book holds `-001`/`-002` since 2026-08-14 — `ac-live-proof.json` `proof.create_so` |
| `HC-PO-2608` | 2 | book holds `-001` since 2026-08-17 — `proof.so_to_po` |
| `HC-DO-2608` | 3 | book holds `-001`/`-002` since 2026-08-17 — `proof.so_to_do`, **and** `public.autocount_delivery_orders` (the DO mirror pulled FROM the book, mig 0215) still carries both |
| `HC-SI-2608` | 2 | book holds `-001` since 2026-08-17 — `proof.do_to_iv` |
| `HC-PI-2608` | 2 | book holds `-001` since 2026-08-17 — `proof.gr_to_pi` |
| `HC-GRN-2608` | 2 | **NOT a book number** — see below |
| every `2990-…` series | live max + 1 | seed 1, i.e. exactly today's answer. 2990 was never wiped and nothing 2990 mints has reached AED_HOUZS, so it does not move |
| everything else | not seeded | self-seeds from its own live max on first mint |

**The one value that is not book evidence, said plainly.** `HC-GRN-2608` is
seeded to 2 because the ERP ISSUED `HC-GRN-2608-001` and queued it for export —
found in `scm.grns` (2026-08-20T12:29:50Z) and `scm.autocount_outbox`
(12:29:51Z) by run 32454881949, both since deleted by the 2026-08-21 wipe, so
that run is now the only record of them. The book's goods-receipt number is
`HC-GR-2608-001`, a DIFFERENT string that no minter here produces, and whether
the office host maps one onto the other is **UNKNOWN**. Seeding costs one number
and stops a number already offered to the book being offered again; if the
answer turns out to be no, `HC-GRN-2608-001` simply goes unused. The counter row
says this in its own `seed_source`.

**Series left without book evidence, and therefore exposed if one exists that
nobody recorded:** every HC type other than the six above — PV, DR, PRT, STK,
ST, the six consignment types, TRIP and JE. None has ever been enqueued to
AutoCount (§4), so a re-issue there is an internal numbering question rather
than an account-book divergence. That stops being true the moment another type
is enqueued.

**What could still be missed.** The outbox held 30 rows before the wipe and
`ac-live-proof.json` names 8 document numbers across 6 operations. If any of the
other rows carried a number that reached the book and was never recorded in that
file, the seed cannot know about it — §2.3a explains why the evidence is gone.
The residual risk is bounded and detectable in the same way as before: AutoCount
refuses with `Primary Key Error`, now for one document rather than a whole
series.

### Superseded recommendation (kept for the record)

**Option A now, Option B as the fix.**

A is already the pending decision and it clears the four stuck documents plus the
three armed ones. B is what every mainstream ERP does, removes the whole class
rather than this instance, and makes "reset the numbering" an explicit input to
the wipe instead of an invisible side effect of deleting rows. C is a reasonable
second choice if the appetite for touching the minter is low, but it keeps a
`MAX()` scan the codebase has already been bitten by twice and adds a table that
must be remembered in every future cleanup script.

**Whichever is chosen, one thing is required in the same change:** the wipe must
stop clearing `scm.autocount_outbox` silently, or must record the exported
high-water mark somewhere it does not delete. Otherwise the ERP keeps forgetting
what it has sent, and the account book stays the only party that remembers.

## 7. Deferred / open

- ~~**Owner decision on all of §6.**~~ DECIDED — option B, shipped 2026-08-21.
- ~~**`HC-DO-2608-001/002` and `HC-SI-2608-001` are armed.**~~ CLOSED by the
  seed: those two series start at 003 and 002.
- **The five re-issued ERP documents no longer exist.** A second go-live wipe
  ran in apply mode on 2026-08-21 (runs 32455489040 then 32456178028) and
  deleted every HC transaction row, including `HC-SO-2608-001/002`,
  `HC-PO-2608-001`, `HC-PI-2608-001` and the GRN. **So there is nothing left to
  re-raise or repair** — the operational follow-up is now only that those
  numbers must never be handed out again, which is what the seed does. The
  "Send now" question is moot: the documents are gone, and re-creating them is a
  business decision about whether those orders still exist, not a repair.
- **`HC-PI-2608-001` was re-issued but reported as `skipped`, not `failed`.** The
  outbox health report still cannot distinguish "skipped for its own reason"
  from "skipped AND carrying a number the book already holds". Open.
- **The wipe cleared `scm.autocount_outbox` a SECOND time on 2026-08-21**, in
  front of this investigation, taking 8 rows with it. The fix in
  `fix/doc-no-counter-table` moves the outbox to the wipe's KEEP list and
  cancels HC's `pending` rows instead of deleting them — but that fix had not
  merged when the wipe ran, so the loss is real and the third set of outbox
  evidence is gone too.
- **GRN vs GR naming.** Our minter writes `HC-GRN-…`; the book holds
  `HC-GR-2608-001`. UNKNOWN whether the host derives one from the other. Worth
  settling before the GRN path goes through the queue.
- **`nextJeNo` uses `.order().limit(1)`**, a lexical sort that breaks at 10,000
  JEs per month — deliberate and documented at `doc-no.ts:44-57`, noted here only
  so a numbering change considers it in the same pass.

## 8. Lessons

1. **A counter derived from live data is not a counter — it is a query, and a
   query answers whatever the data currently says.** The comment in `doc-no.ts`
   defends `max+1` over `count+1` and is right to; the unexamined assumption is
   that the surviving rows are a faithful record of what was issued. The moment
   anything deletes, they are not.
2. **When a number leaves the system, the system stops being the only authority
   on it.** Exporting a document number to AutoCount creates a second namespace
   the ERP cannot see and cannot wipe. Any counter that ignores the second
   namespace will eventually collide with it.
3. **A cleanup that also deletes the export log destroys the evidence needed to
   detect its own side effects.** The outbox being on the wipe's CLEAR list is
   why `sentBefore=0` read as "never sent" instead of "we no longer remember".
4. **The reported symptom set was incomplete, and only a census found the rest.**
   Four documents were reported; the measurement found a fifth already re-issued
   and three more armed. Counting from the queue counts only what the queue
   happens to show.

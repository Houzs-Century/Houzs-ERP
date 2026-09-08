## The AutoCount write-back could tell a licensed book that a part-paid migrated order was settled [high]

**Symptom.** Nothing was seen, and that is the reason this entry exists. It is
the follow-up
`docs/bugs/0723-the-sales-order-detail-showed-a-paid-up-balance-of-0-on-ever.md`
named in its own closing paragraph: PR #3306 fixed the SCREEN's half of a
shared root cause on 2026-09-08 and deliberately left the write-back's half
alone. The screen showing RM 0.00 was embarrassing; the write-back doing the
same thing writes `UDF_BALANCE = 0.00` into a LICENSED ACCOUNT BOOK, where it
means "this customer owes nothing" about a customer who owes RM 1,600.00.

**Root cause (traced, on `origin/main` at `c245211b3`).** One guard, testing
for the wrong absence.

1. `readSoOutstandingSen` (`backend/src/scm/lib/autocount-read.ts:70`) refused
   only a NULL: `if (h.total_revenue_sen == null || !Number.isFinite(total))
   return null;`. Its own docblock makes exactly the right decision for that
   case — a missing total is not a fact, so omit the key and let the book keep
   its own value.
2. `scm.mfg_sales_orders.total_revenue_sen` is `integer DEFAULT 0 NOT NULL`
   (`backend/scripts/scm-schema/2990s-full-schema.sql:668`; the `_centi ->
   _sen` rename at `migrations-pg/0305:211` preserved both). So against the
   live schema **the NULL branch cannot fire at all** — it fires only when a
   caller's SELECT list omits the column, and both callers select it.
3. The cutover importer never writes the column: `HCOLS` in
   `backend/scripts/import-ac-outstanding-so.mjs:397` carries `local_total_sen,
   balance_sen, paid_sen, deposit_sen` and not `total_revenue_sen` — grepped,
   it is the file's only occurrence of the name. Every imported order therefore
   carries a hard 0, and `recomputeTotals`, which would fill it, does not run on
   an order nobody edits.
4. 0 is not NULL, so the guard stood aside and the reader computed
   `soOutstandingSen({ totalRevenueSen: 0, ... }) = max(0, 0 - 160000) = 0`.
   Both composers then SEND that 0 rather than dropping it, correctly and by
   design: `acUdfMoney(0)` is the truthy string `"0.00"`, which passes the
   create path's `udf()` filter (`services/autocount-writeback.ts:1095,1281`),
   and the edit path is explicitly `if (balance != null)` for the same stated
   reason (`scm/lib/so-edit-header.ts:178`) — a settled order has to stop
   showing a debt.

Scale, from 0723's measurement rather than a new one: `total_revenue_sen` was 0
on **2,687 of production's 2,824 live orders** (`probe-so-overpay.mjs`, run
31938735652 section b).

**It was NOT unreachable.** 0723 said the path was "unreachable today only
because migrated orders are read-only — luck, not a guard". Reading
`lib/migrated-so-readonly.ts` refutes the premise as well as the luck: the lock
is applied at two router mounts and has an explicit, documented bypass —
`migratedSoReadonlyState` returns `locked: false` for any caller
`callerBypasses(c)` accepts (`*` / `scm.admin`), because IT must still be able
to correct a migrated document during the lock. An IT save of a migrated sales
order reaches `queueAcSoEdit` -> `composeSoState` -> `soEditHeader` -> `BALANCE`
today. Two further doors: `/autocount-outbox` is mounted with no migrated-SO
guard at all (`scm/index.ts:593` against `:364`) and its "Send again" ladder
calls `enqueueEdit` for an SO by doc number
(`lib/autocount-requeue.ts:665,685`); and the lock's newer `verdict:` mode
opens a migrated order by itself the moment a reconcile run publishes it clean.
UNVERIFIED: what value `scm.app_config.'scm.migrated_so_lock'` actually holds in
production — nobody on this change has database access, and the migration seeds
`'1'`.

**Fix.** `readSoOutstandingSen` now refuses any `total_revenue_sen` that is not
greater than zero — `if (!(total > 0)) return null;` — which is the identical
"0 is not a fact" judgement the function's docblock already made for NULL. The
`> 0` form subsumes the NULL and non-finite checks it replaces and additionally
catches a negative, which `max(0, ...)` would have turned into a confident 0.
`null` means "the ERP has no answer": both callers then omit the key and
AutoCount keeps its own `UDF_BALANCE`.

REFUSE rather than fall back to `local_total_sen` (which is what the screen now
does), for three reasons, in order of weight:

- Refusing keeps a number known to be right. The book's `UDF_BALANCE` is where
  the ERP's figure came from — the import computed `paid = total - UDF_BALANCE`
  from it — so saying nothing leaves the book holding the value this repo
  treats as the source of truth.
- The ERP's PAID figure is known incomplete on exactly these orders.
  `lib/migrated-so-lock.ts` records it in its own header: payments taken in
  AutoCount since 2026-08-28 have never reached the ERP and there is no
  automatic path. `local_total_sen - paid` would OVERSTATE the debt on a
  migrated order, and a customer would be chased for money already received.
- A screen and a ledger are different acts. `soOutstandingSen` takes
  `SoPaidInputs`, which has no `localTotalSen` field, precisely so this reader
  cannot quietly acquire the screen's fallback; PR #3306 added the field to
  `SoBalanceInputs` only.

Nothing else moved. `soOutstandingSen` is untouched, so PR #3306's pin that the
ledger's arithmetic did not shift still passes unchanged; only the stale comment
above it — which promised this follow-up and asserted the unreachability — was
corrected.

**Pinned by 11 assertions in a new suite,
`backend/src/scm/lib/autocount-read.test.ts`, proved RED on the unfixed tree**
(written before the source edit, then
`npx vitest run --config vitest.light.config.mts src/scm/lib/autocount-read.test.ts`):
**3 failed | 8 passed**, the three being the defect itself —
`expected +0 not to be +0` on the owner's own numbers (total 320000 sen, paid
160000), and `expected +0 to be null` for a zero total and for a negative one.
The 8 that passed RED are the must-not-move half and are the point of the split:
a genuine total still computes, a SETTLED order still answers 0 so `"0.00"`
still reaches the book, the legacy header deposit still counts once, an
over-collection is still clamped, and an unreadable payments ledger still
THROWS rather than reading as unpaid. All 11 pass on the fixed tree, as do
`so-outstanding.test.ts`, `autocount-outbox.test.ts`,
`autocount-writeback.contract.test.ts` and `autocount-requeue.test.ts`
(255 passed | 7 skipped).

**Not observed: production.** No query was run against the live database and no
document was sent to the account book — nobody on this change has database
access. Every claim above is from the source tree at `c245211b3` or from the
measurement 0723 recorded. **UNTESTED:** whether any already-queued outbox row
carries a `BALANCE` of `"0.00"` composed under the old rule; this change alters
what is composed from now on and does nothing to a payload already written.

**Ref.** `fix/autocount-refuse-zero-total`, 2026-09-09.

# COE — a migrated order's balance never reached the book: the lock was off, and the write-back refused to push it

**Date.** 2026-09-12.

**Trigger — what staff saw, in the owner's words.** 「Have key in in ERP but the
delivery sheet no update the payment balance」. A balance collected on an old
order and keyed into the ERP did not reduce the outstanding on the "HC Delivery
Updated" operations sheet; the customer kept reading as owing money already paid.

## Root cause, traced with evidence

Read-only, via Supabase MCP against production `anogrigyjbduyzclzjgn`; the
write-back path read on `origin/main`.

**The sheet's HC balance is AutoCount's, and the ERP push normally reaches it.**
For company-1 orders the sheet pulls the Balance from AutoCount via the
sheet-bound `GetAutoCountData.gs` (stated in `backend/src/routes/assrFormIntake.ts`).
Recording a payment in the ERP enqueues an `edit` write-back that stamps
AutoCount's `UDF_BALANCE`, and for a NORMAL (ERP-native) order the sheet reflects
it — the owner confirmed this is the everyday behaviour. So the push channel
works; the 34 migrated orders were an exception, for two compounding reasons:

1. **The lock that would have stopped the ERP entry was off.**
   `scm.migrated_so_lock` (owner 2026-09-08 「只开新单，旧单暂时不能改」; seeded
   `'1'` by mig `20260908T0014`) read **`off`** in prod, so migrated orders were
   editable and staff keyed balance collections onto them in the ERP.

2. **Even recorded, the write-back REFUSED to push a migrated order's balance.**
   `readSoOutstandingSen` (`backend/src/scm/lib/autocount-read.ts`), which
   composes `UDF_BALANCE`, returned `null` when `total_revenue_sen` was not `> 0`
   — and a migrated order carries its total in `local_total_sen`, with
   `total_revenue_sen` at 0 (0 on 9 of 10 sampled). So the `edit` was `sent` but
   **omitted `UDF_BALANCE`**, and AutoCount kept its import-time value. This
   refusal was deliberate — a safety against overwriting AutoCount with an ERP
   figure known incomplete on migrated orders (payments taken in AutoCount since
   2026-08-28 not reaching the ERP, docs/bugs/0678).

**Measured exposure.** 34 company-1 migrated orders carried a post-import
collection recorded in `scm.mfg_sales_order_payments`, RM 101,034 in total
(dates 2026-09-04 .. 2026-09-12). ERP `balance_sen_live` read 0 on the settled
ones while the sheet still showed the pre-payment balance.

## Fixes shipped

| change | effect |
| --- | --- |
| `scm.app_config` `scm.migrated_so_lock` `off` -> `'1'` (2026-09-12, Supabase MCP, owner-authorised) | migrated orders read-only again across desktop, mobile and the backend router; stops NEW ERP edits on old orders |
| `readSoOutstandingSen` falls back to `local_total_sen` when `total_revenue_sen` is 0 (+ `local_total_sen` added to `SO_HEADER_COLS`) | the write-back now composes `UDF_BALANCE` for migrated orders — safe now AutoCount is PUSH-ONLY (owner), so the ERP figure is complete. The safety's premise (reason 2 above) is retired for the go-forward window |
| `backend/scripts/backfill-migrated-so-balance-push.mjs` + `.github/workflows/backfill-migrated-so-balance-push.yml` | re-pushes the 34 (one keyed edit each, no rebuild). Dry-run default; APPLY needs the confirm phrase; PARTIAL balances held back for a human to verify (reason 2 residual) |

The owner's ruling that frames all three: **AutoCount is locked to hand-entry and
the ERP is the only way a figure reaches the book**, so the book must learn a
migrated order's balance from the ERP — the opposite of the old safety.

## What the audit ruled out

- **The write-back queue.** Suspected first (there is a real failed-`edit`
  backlog — e.g. `HC-SO-013496` `body too large`, 33 failed edits). Refuted for
  this symptom: 32 of the 34 latest `edit` rows were `sent`. The queue delivered;
  the fault was the composer OMITTING `UDF_BALANCE` for migrated orders.
- **"A `UDF_BALANCE` stamp doesn't reach the sheet."** An early wrong guess.
  Refuted by the owner: a normal order's ERP payment DOES update the sheet, so it
  reads exactly what the ERP pushes — the migrated orders simply weren't pushed.
- **`scm.delivery_order_payments` missing in prod.** Real and worth its own note
  (the table exists only as an empty legacy `public.` copy on `amount_centi`; no
  migration builds the `scm` one — so `docs/bugs/0704`'s premise that
  door-collected money "is stored, just not synced" is itself wrong). But DO
  payments are not the sheet's source, so this is a separate latent bug.
- **A stale ERP balance snapshot.** The ERP was the correct side
  (`balance_sen_live` 0, the collection recorded); the sheet was the stale one.

## Deferred — owner's call

- **The reason-2 residual.** An order paid DIRECTLY in AutoCount in the window
  2026-08-28 .. the lock, never reaching the ERP (docs/bugs/0678), would have its
  debt OVERSTATED by `local_total - paid`. The clamp keeps it non-negative; the
  backfill holds PARTIAL balances back for verification against the book.
- **Going-forward collections on old orders.** The lock stays `'1'`, so a
  collection on a migrated order cannot currently be recorded in the ERP (nor in
  AutoCount, which is locked). The lock is lifted (→ off) once the collections
  are reconciled, or a narrower path is chosen — the owner's decision.
- `scm.delivery_order_payments` absent (`docs/bugs/0704`); the inbound half,
  AutoCount payments not reaching the ERP (`docs/bugs/0678`).

## Lessons

- **The write-back's balance reader must feed off the SAME total the screen
  uses** once the ERP is the source of truth. A two-column total
  (`total_revenue_sen` vs `local_total_sen`) with the reader picking the one
  migrated orders lack is this repo's recurring write-back shape — the next
  instance after `supplier_sku`, the stock location and the salesperson
  (`docs/autocount-writeback-golive-coe.md`).
- **`sent` in the outbox means dispatched, not "the field landed".** A `sent`
  edit that omits `UDF_BALANCE` leaves the book unchanged. Read the composed
  payload, not just the status.
- **Verify a switch against the live DB, not its migration.** `migrated_so_lock`
  was seeded `'1'` yet read `'off'` in production (as `system-foundation-coe.md`
  also found).
- **The HC operations sheet's Balance is AutoCount's.** For a collection to show
  there it must reach AutoCount's own field — which, for a migrated order, only
  happens once the write-back stops refusing it.

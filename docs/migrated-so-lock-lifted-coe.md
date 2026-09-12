# COE — the migrated-SO lock was lifted, and old-order collections stopped reaching the book

**Date.** 2026-09-12.

**Trigger — what staff saw, in the owner's words.** 「Have key in in ERP but the
delivery sheet no update the payment balance」. A balance collected on an old
order and keyed into the ERP did not reduce the outstanding on the "HC Delivery
Updated" operations sheet; the customer kept reading as owing money that had
already been paid.

## Root cause, traced with evidence

Read-only, via Supabase MCP against production `anogrigyjbduyzclzjgn`. Two facts
compound:

1. **The sheet's HC balance is AutoCount's, not the ERP's.** For company-1
   (Houzs Century) orders the "HC Delivery Updated" sheet pulls the Balance
   column from AutoCount via the sheet-bound `GetAutoCountData.gs` — stated in
   `backend/src/routes/assrFormIntake.ts` (the "2990 SO -> HC Delivery sheet
   export" was built precisely because 2990's orders never reach AutoCount).
   Recording an SO payment in the ERP enqueues an `edit` write-back that stamps
   AutoCount's custom field `UDF_BALANCE`; it does NOT post a real AutoCount
   receipt, so AutoCount's own receivable — the number the sheet reads — does not
   move.

2. **The safety switch that would have stopped the ERP entry was off.**
   `scm.migrated_so_lock` (`backend/src/scm/lib/migrated-so-lock.ts`; owner
   2026-09-08 「只开新单，旧单暂时不能改」; seeded `'1'` by migration
   `20260908T0014_scm_migrated_so_lock.sql`) was found **`off`** in prod. With it
   off, migrated (old) orders were editable, so staff keyed balance collections
   onto them in the ERP.

**Measured exposure.** 34 company-1 migrated orders carried a post-import
collection recorded in `scm.mfg_sales_order_payments`, RM 101,034 in total
(dates 2026-09-04 .. 2026-09-12). On each, ERP `balance_sen_live` read 0 (paid)
while the sheet still showed the pre-payment balance. The pattern per order: one
`imported` deposit row (go-live) plus one later real row (`transfer` etc.) whose
amount equals the balance the sheet still shows.

## Fixes shipped

| change | effect |
| --- | --- |
| `scm.app_config` `scm.migrated_so_lock` `off` -> `'1'` (2026-09-12, Supabase MCP, owner-authorised) | company-1 migrated orders read-only again across desktop, mobile and the backend router that read the switch; the ERP stops accepting collections on old orders, so the divergence stops growing |
| this COE + `docs/bugs/0842-*` | the record, and the switch's lifecycle written down |

The decision behind the flip: **AutoCount is the master for old-order collections
and balance; the ERP is not a second place to record them.** Its counterpart for
orders the ERP does not hold at all (~1,240 SOs exist in AutoCount but not the
ERP, estimated as sheet total 4,183 minus ERP company-1 2,943): record the
collection in AutoCount — never fabricate a partial SO in the ERP to hold a
payment, which is how a second, disagreeing record is born.

## What the audit ruled out

- **The write-back queue.** Suspected first (there is a real failed-`edit`
  backlog — e.g. `HC-SO-013496` `body too large`). Refuted for this symptom: of
  the 34 orders, 32 latest `edit` rows were `sent`. The queue delivered; the
  problem is that a delivered `edit` only stamps `UDF_BALANCE`, which is not the
  number the sheet reads.
- **`scm.delivery_order_payments` missing in prod.** Real and worth its own
  entry: the table exists only as an empty legacy `public.` copy on the old
  `amount_centi` unit, and no migration builds the `scm` one — so
  `docs/bugs/0704`'s premise that door-collected money "is stored, just not
  synced" is itself wrong. But DO payments are not the sheet's source, so this is
  a separate latent bug, not this symptom.
- **A stale ERP balance snapshot.** The ERP was the correct side here
  (`balance_sen_live` 0, the collection recorded); the sheet was the stale one.

## Deferred — owner's call

- The 34 historical collections (RM 101,034) entered into AutoCount by hand; the
  per-order CSV was handed to the owner.
- Native ERP-born orders' later payments: a smaller residual, still
  `UDF_BALANCE`-only. Closing it is the "post a real AutoCount receipt from the
  ERP" work, the most dangerous class on this cutover.
- `scm.delivery_order_payments` absent in prod (`docs/bugs/0704`); the inbound
  half, AutoCount payments not reaching the ERP (`docs/bugs/0678`).

## Lessons

- **The `migrated_so_lock` switch IS the payment-discipline control.** Turning it
  off re-opens the exact divergence it exists to prevent; its off-state carries a
  money cost and is an operational decision, not a neutral default. Its own file
  says the only reason to lift it is "when collections are corrected" — that
  precondition was not met when it was lifted.
- **Verify a switch against the live DB, not its migration.** It was seeded `'1'`
  in `20260908T0014` yet read `'off'` in production; the file did not tell the
  truth about the running value. (Same lesson as `system-foundation-coe.md`.)
- **The HC operations sheet's Balance is AutoCount's.** For a collection to show
  there it must reach AutoCount's own receivable; a `UDF_BALANCE` stamp does not.

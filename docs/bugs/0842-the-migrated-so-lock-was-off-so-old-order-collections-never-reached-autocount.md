## The migrated-SO lock was off, so old-order collections keyed in the ERP never reached AutoCount or the delivery sheet [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** Owner 2026-09-12: 「Have key in in ERP but the delivery sheet no
update the payment balance」. A balance collected on an old order and keyed in the
ERP did not change the "HC Delivery Updated" operations sheet's Balance column —
the customer kept reading as owing money that had already been collected.

**Root cause (traced, not guessed — Supabase MCP against prod
`anogrigyjbduyzclzjgn`, read-only; write-back read on origin/main).** The sheet's
HC (company-1) Balance is pulled from AutoCount by the sheet-bound
`GetAutoCountData.gs` (`backend/src/routes/assrFormIntake.ts`), and a NORMAL
order's ERP payment DOES reach it (owner-confirmed everyday behaviour). The 34
migrated orders were the exception, for two compounding reasons:

1. `scm.migrated_so_lock` (`backend/src/scm/lib/migrated-so-lock.ts`; owner
   2026-09-08 「只开新单，旧单暂时不能改」; seeded `'1'` by mig
   `20260908T0014_scm_migrated_so_lock.sql`) was found **`off`**, so migrated
   orders were editable and staff keyed collections onto them in the ERP.
2. Even recorded, the write-back REFUSED to push a migrated order's balance:
   `readSoOutstandingSen` (`scm/lib/autocount-read.ts`), which composes
   `UDF_BALANCE`, returns `null` when `total_revenue_sen` is not `> 0` — and a
   migrated order carries its total in `local_total_sen` with `total_revenue_sen`
   at 0 (0 on 9 of 10 sampled). So the `edit` was `sent` but OMITTED
   `UDF_BALANCE`, and AutoCount kept its import-time value.

Result: 34 company-1 migrated orders carried a post-import collection recorded in
`scm.mfg_sales_order_payments` (RM 101,034 in total) — ERP `balance_sen_live`
read 0 on the settled ones while the sheet still showed the pre-payment balance.
The write-back queue was NOT the fault: 32 of the 34 latest `edit` rows were
`sent`.

**Fix.** Three parts:
- **Config:** `scm.app_config.scm.migrated_so_lock` `off` -> `'1'` (2026-09-12,
  Supabase MCP, owner-authorised) — migrated orders read-only again (desktop +
  mobile + router); stops NEW ERP edits on old orders.
- **Code:** `readSoOutstandingSen` falls back to `local_total_sen` when
  `total_revenue_sen` is 0 (+ `local_total_sen` added to `SO_HEADER_COLS`), so the
  write-back composes `UDF_BALANCE` for a migrated order. Safe now AutoCount is
  push-only (owner) so the ERP figure is complete; the old refusal's premise
  (docs/bugs/0678) is retired for the go-forward window. Pinned in
  `autocount-read.test.ts`.
- **Backfill:** `backend/scripts/backfill-migrated-so-balance-push.mjs` +
  `.github/workflows/backfill-migrated-so-balance-push.yml` — re-pushes the 34
  (one keyed edit each, no rebuild); dry-run default, confirm-phrase gate, PARTIAL
  balances held back for a human to verify.

**What this does NOT do.** A PARTIAL-balance order carries a residual overstate
risk (a customer who paid directly in AutoCount 2026-08-28..lock, docs/bugs/0678)
— the backfill holds those for verification. The lock stays `'1'`, so an old
order cannot take a NEW ERP collection until the owner lifts it.
`scm.delivery_order_payments` absent in prod (docs/bugs/0704) is a separate latent
bug.

**Ref.** config flip + code fix + backfill 2026-09-12; `docs/migrated-so-lock-lifted-coe.md`.

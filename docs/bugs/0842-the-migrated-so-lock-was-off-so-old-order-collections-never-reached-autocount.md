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
  mobile + router); stops NEW ERP edits on old orders. **Not the production state
  — see the correction below.**
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
— the backfill holds those for verification. ~~The lock stays `'1'`, so an old
order cannot take a NEW ERP collection until the owner lifts it.~~ (Wrong about
production — see below: old orders take ERP collections today.)
`scm.delivery_order_payments` absent in prod (docs/bugs/0704) is a separate latent
bug.

**Correction (2026-09-14) — the lock is OFF in production, and has been since
2026-09-12 18:55 MYT.** This entry and its COE were merged at 23:56 MYT that day
saying the lock "stays `'1'`". The switch's own runs say otherwise, each re-read
on 2026-09-14:

- `set-migrated-so-lock.yml` run 34689675812 (2026-09-12 18:54 MYT, `MODE=apply`):
  `BEFORE "1" (updated 10/09/2026, 14:04:10 MYT)` → `AFTER "off"`,
  `1 HOUZS migrated=2882 shut -> open`. That is the owner's same-evening ruling
  that a migrated order is one of our orders — recorded, with the lift, in
  `docs/bugs/0842-staging-could-not-reproduce-a-production-lock-because-the-re.md`.
- Run 34689885454 (19:00 MYT, `MODE=apply`): `"off"` → `"off"`, unchanged.
- Run 34830061288 (2026-09-14 17:50 MYT, `MODE=plan`, writes nothing):
  `"off" (updated 12/09/2026, 18:55:12 MYT)`, `1 HOUZS migrated=2882 new=75 open -> open`.

So migrated orders ARE editable and DO take ERP collections — which is what the
code fix above is for: with the lock off, those collections now reach
`UDF_BALANCE`. **Do not "restore" `'1'` on the strength of this entry.**

Not resolved here: this entry says the lock was *found* `off` and set to `'1'`,
but at 18:54 MYT the row read `'1'` last updated 2026-09-10 14:04 MYT, which is
also what the staging 0842 entry records. A Supabase MCP `UPDATE` that did not
touch `updated_at` would fit both; nothing on record shows which.

**Ref.** config flip + code fix + backfill 2026-09-12; `docs/migrated-so-lock-lifted-coe.md`.

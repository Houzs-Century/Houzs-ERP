## The migrated-SO lock was off, so old-order collections keyed in the ERP never reached AutoCount or the delivery sheet [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** Owner 2026-09-12: 「Have key in in ERP but the delivery sheet no
update the payment balance」. A balance collected on an old order and keyed in the
ERP did not change the "HC Delivery Updated" operations sheet's Balance column —
the customer kept reading as owing money that had already been collected.

**Root cause (traced, not guessed — Supabase MCP against prod
`anogrigyjbduyzclzjgn`, read-only).** Two facts compound:

1. The sheet's HC (company-1) Balance is pulled from AutoCount by the
   sheet-bound `GetAutoCountData.gs` — stated in `backend/src/routes/assrFormIntake.ts`
   (the "2990 SO -> HC Delivery sheet export" exists precisely because 2990's
   orders never reach AutoCount). Recording an SO payment in the ERP enqueues an
   `edit` write-back that stamps AutoCount's custom `UDF_BALANCE`; it does NOT
   post a real AutoCount receipt, so AutoCount's own outstanding — the number the
   sheet reads — does not move.
2. The `scm.migrated_so_lock` switch (`backend/src/scm/lib/migrated-so-lock.ts`;
   owner 2026-09-08 「只开新单，旧单暂时不能改」; seeded `'1'` by migration
   `20260908T0014_scm_migrated_so_lock.sql`) was found **`off`**. With it off,
   migrated orders were editable, so staff keyed balance collections onto them in
   the ERP.

Result: 34 company-1 migrated orders carried a post-import collection recorded in
`scm.mfg_sales_order_payments` (RM 101,034 in total) — ERP `balance_sen_live`
read 0 (paid) while the sheet still showed the pre-payment balance. The
write-back queue was NOT the fault: 32 of the 34 orders' latest `edit` rows were
`sent`.

**Fix.** `scm.app_config` key `scm.migrated_so_lock` set `off` -> `'1'`
(company-1 migrated orders read-only again — on the desktop, mobile, and backend
router that already read this switch), 2026-09-12, applied live via Supabase MCP
with the owner's authorisation. Collections on old orders now go to AutoCount,
which the sheet reads. The switch's lifecycle is unchanged: lift it (-> off) only
once AutoCount collections have been corrected. Full write-up:
`docs/migrated-so-lock-lifted-coe.md`.

**What this does NOT do.** The 34 historical collections (RM 101,034) still need
to be entered in AutoCount by hand (CSV handed to the owner). Native ERP-born
orders' later payments remain a smaller residual (still `UDF_BALANCE`-only).
`scm.delivery_order_payments` being absent in prod (docs/bugs/0704) is a separate
latent bug, not this symptom's cause.

**Ref.** config flip 2026-09-12; `docs/migrated-so-lock-lifted-coe.md`.

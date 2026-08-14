> **ARCHIVED 2026-08-13.** Session baton from **2026-07-24**; every PR it lists was merged that day. Kept as the record of what was checked. Current state: `docs/2990-cutover/HANDOFF.md`. Kept for history; do not follow it as a current instruction.

# Session handoff — 2990 → Houzs go-live hardening (2026-07-24)

> **SESSION 2 CLOSE (2026-07-24, later):** 13 PRs merged and DEPLOYED (verified
> success): #1182 SO drill stock/incoming-PO columns, #1184 supplier code/name
> split, #1185 delivered-DO backfill tool (APPLIED: 12 DOs+SOs -> DELIVERED,
> 19/19 verify), #1186+#1194 fabric supplier-code format (final: `CG-001 Pearl
> (KN390-1)` - parens LAST), #1187 StatePicker combobox, #1191 processing_date
> column retired (NOTE: its 0189 migration failed on a dependent VIEW; partner
> session fixed via #1203 drop-view-first - LESSON: check dependent views before
> DROP COLUMN), #1192+#1196 system font everywhere (plain zero, owner), #1195
> combo-pricing selling-map display, #1199 full status tabs, #1200 DataTable
> sort/filter/clip. Owner rulings recorded: DO/In-Transit backend belongs to the
> PARTNER's session - hands off; SO/PO Amendment redesign approved but queued
> LAST after: Sales Director POS = exact 2990 parity, Org Chart by company,
> Sales Venue save bug, global allocation sweep for migrated SOs, MRP coverage
> snapshot-to-DB. Diagnostics added to Actions: amendment-apply check,
> 2990-delivered-chain check, delivered-DO backfill (DRY-RUN gated). Price
> baseline APPLY still HELD (dup/RM0 rows).

> **STATUS UPDATE (same day, later session — this list is CLEARED unless noted):**
> - **#1174 MERGED** (order lines CODE + variant; conflict with #1175 resolved keeping both).
>   **#1179 MERGED** (processing_date read fix). **#1165 MERGED** (mig 0188; SQL reviewed:
>   idempotent, NOT VALID FKs, no runtime `ON CONFLICT` on any changed key — verified by grep).
>   Diags **#1105 / #1092 MERGED**. Every merge verified with `gh pr view --json state`, per
>   the lesson below.
> - **Price baseline backfill: DRY-RUN done, APPLY deliberately HELD.** 2990 plans 109
>   products / 186 rows, but the sample shows SAME-DAY DUPLICATE rows and RM0.00 rows
>   (AKKA-FIRM MATT (S): 883.00 + 0.00 + 0.00 all effective 2026-06-01). Do NOT apply until
>   the reconstruction filters zero/duplicate rows — phase 3 would price off this table.
>   HOUZS plans 0 products (no live catalog prices there — worth a look, may be expected).
> - **Amendment mystery SOLVED** (new read-only diag: Actions → "Amendment apply check").
>   SO-2607-015/A1 was NEVER approved — status REQUESTED, `so_approved_at` NULL, zero
>   snapshots. The owner could not find the approve button (hidden behind supplier-confirm).
>   Owner has approved a redesign: 2-step SO amendment, PO dual-track, auto PO revision —
>   see the mockup artifact + chat; build starts AFTER this handoff's items.
> - **Worktrees at `Desktop/hz-baseline-worktrees/` all removed** (all 7 PRs merged, all clean).
> - Still open for the OWNER: the 4 decisions below (12 DELIVERED SOs, COD?, POS roles,
>   #103 screenshot), Resend delivery test (#101), supplier-404 entry page when it recurs.
> - Still open (engineering): processing_date column retirement, #98 members filter,
>   pricing phase 3, PI/PR/GRN fabric-supplier-code read enrichment (deferred in #1174).

Working clone: `Desktop/hz-baseline` = `hello-houzs/Houzs-ERP`. Multi-company:
HOUZS = `company_id 1`, 2990 = `company_id 2` (migrated from `wenwei4046/2990s`).
The owner is **live-testing 2990 data inside Houzs** and deciding whether to
call it "fully live". This session was a rapid owner-feedback loop: fix UI/data
issues + verify the migration with read-only diagnostics. Most work was fanned
out to background agents that opened PRs.

`main` has **no branch protection** — you are the merge gate. Re-check CI green
+ `mergeStateStatus` immediately before merging. Local `vitest` is broken in
this clone (`@cloudflare/vitest-pool-workers`) — rely on CI; `typecheck` runs
locally. Migrations: live tree `backend/src/db/migrations-pg/` auto-applies on
merge; take the next number at MERGE time (latest merged so far: **0187**).

---

## ⚠️ CRITICAL LESSON from this session — verify background merges
The background "watch-and-merge" one-liners **failed silently**: they ran
`gh pr checks` / `git fetch` from the wrong cwd (`C:\Users\User`, not the repo)
→ "not a git repository" → the `&&` chain broke before `gh pr merge`, but the
outer `echo "done $?"` printed 0 and the task reported success. Result:
**#1174 / #1167 / #1164 never merged** even though the logs said "MERGED", so the
owner "didn't see" the deployed changes. **ALWAYS `gh pr view <n> --json state`
after any background merge.** Prefer `git -C <repo>` / `gh --repo <owner/repo>`,
or just merge in the foreground.

---

## Merged this session (LIVE on main)
See `git log origin/main` for the full list; the notable ones:
- **#1158** supplier detail 404 → calm "belongs to 2990, switch" instead of "gone" (+ `detailMissResponse` helper, `docs/cross-company-detail-404-coe.md`).
- **#1156 / #1159** Fabric Converter Supplier Code column restored + `fabricDualCode` now parens `BF-01 (PC151-01)`; backfill finding: 2990 already has the codes, HOUZS's 705 fabrics are a different catalog not in 2990.
- **#1160** Pricing "Option B" foundation — mig 0187 `scm.mfg_product_price_history` + resolver `product-pricing-history.ts` (inert; `docs/pricing-effective-dating-design.md`).
- **#1167** Pricing write endpoint `POST/GET /mfg-products/:id/price-changes` + Product Maintenance timeline UI + `backend/scripts/backfill-product-price-baseline.mjs` (DRY-RUN gated). Does NOT touch the recompute.
- **#1164** StatePicker: grouped-by-country + type-search + bordered UI (matched siblings) + dropped Others backdoor.
- **#1169** Columns panel sorted A-Z + removed "Clear POS PIN" (security; Set/Reset kept).
- **#1161** Mobile self-service change-password (desktop already had it; POS is PIN-based).
- Diagnostics (read-only, re-runnable via Actions): **#1157** supplier reachability, **#1168/#1173** migration completeness, **#1176** DO-payments forensic.
- **#1171** `docs/add-company-design.md`. **#754** (wenwei4046/2990s) reversible read-only freeze — MERGED, switch **OFF**.

## Open PRs / just-merged — NEED ATTENTION (state as of session end)
- **#1174 — STILL OPEN, MERGE WHEN GREEN.** On-screen order lines: CODE-only + variant everywhere + fabric `(PC151-01)`. Agent `a62fd581d5614a326` RESOLVED the Fair Report conflict (#1163/#1175) and pushed; GitHub was recomputing mergeability/CI at session end. Do: `gh pr view 1174 --json state,mergeStateStatus`; once CLEAN + CI green → `gh pr merge 1174 --repo hello-houzs/Houzs-ERP --squash --admin` then CONFIRM `state=MERGED`. This is the owner's #1 UI complaint and is NOT live until this lands. Also re-verify it covers the exact "ORDER LINES · SELLING & COST" component the owner sees (may not be only FairReport).
- **#1179 — MERGED.** Processing-date read-column fix (SO detail + list now use `internal_expected_dd ?? processing_date`; the list had the fallback reversed). Live after deploy.
- **#1165 — MERGED (mig 0188).** Per-company UNIQUE on `accounts`/`product_models`/`product_dept_configs`/`pwp_codes`. I had flagged it to review the SQL first; it got merged anyway. It re-adds accounting FKs `NOT VALID` (cannot fail on existing rows; `backend-postgres` CI passed). ⚠️ **VERIFY `APPLIED 0188...` shows in the deploy log** (Actions → deploy on main) — the deploy was still PENDING at session end (a background poll was checking). If that deploy failed, it BLOCKS ALL later migrations — fix before anything else.
- `chore/diag-*` (supplier reachability, migration completeness, DO payments, pos-role-access, amendment-apply) — read-only diagnostics, merged/safe. Re-runnable from Actions.

## Status at true session end (all landed + verified)
- **#1174 MERGED + DEPLOYED** (deploy 30064648326 = success). Order lines now show CODE + variant everywhere.
- **mig 0188 CONFIRMED APPLIED on prod** — deploy log: `APPLIED 0188_percompany_natural_key_masters.sql (11 statements)`, deploy success, zero migration errors. The accounting-FK change is safe/live.
- #1167 (pricing UI), #1164 (StatePicker), #1179 (processing-date) all merged + in that deploy.

## First thing next session should do
Everything mergeable this session is merged + deployed. Next session works the **owner decisions** (① 12 SO delivered status · DO COD payments · #104 Sales Director POS perms · #103 Outstanding page · add-company account-book template) and the **known gaps** (supplier-404 backend root cause, retire the dead `processing_date` column, confirm the exact SELLING&COST component, run the price backfill dry-run, pricing phase 3). Prune the lingering worktrees.

## Migration integrity (the go-live evidence)
Diags ran vs prod (2990 source vs Houzs company_2). **Counts: every doc type
with data is fully migrated except structure.** Two real items + one non-issue:
1. **12 SOs lost DELIVERED status.** 2990 had 19 SOs DELIVERED; Houzs shows 7.
   Houzs derives SO-delivered from a delivered DO/SI, but all DOs are DISPATCHED
   (faithfully — 2990 never marked DOs delivered) and there are 0 SIs. **This is
   why the Sales Report "Delivered" shows ~5-7 not 19.** OWNER DECISION: were the
   goods actually delivered? If yes → backfill the 12 SOs' DELIVERED status.
2. **13 DO payments NOT migrated = CORRECT.** Forensic (#1176) proved all 13 are
   EXACT DUPLICATES of SO-level payments already in Houzs (2990 wrote each deposit
   to both the SO and DO ledger; the SO copy migrated). Additional money = **RM0**.
   Backfilling would DOUBLE-COUNT **RM29,104**. **DO NOT backfill.** Owner also
   asked: DO shouldn't keep its own payments; DO balance should derive from SO —
   pending his answer to "do drivers collect payment at delivery (COD)?" (if no →
   simplify DO to derive balance from SO; if yes → DO payments are legit COD).
3. **Costing: clean.** No cost dropped by migration; the visible RM0 costs
   pre-existed in 2990 (15/68 SOs, 86/203 lines were uncosted in 2990).

## Open OWNER decisions (blocking / needed)
- **① 12 SO DELIVERED status** — restore to match 2990? (goods actually delivered?)
- **DO payments / balance** — do drivers collect at delivery (COD)? decides DO payment model.
- **#104 Sales Director POS perms** — 4 "Sales Director"-position users have `scm.staff.role='sales'` → the live POS (gates on `staff.role`) makes them READ-ONLY. No "Assistant Director" position exists. FIX (pending owner mapping): should Sales Director → full POS (matches 2990)? Sales Manager (5) / Finance Manager (2) too, or view-only? Cleanest fix = sync `scm.staff.role` from `public.positions`, OR make the POS gate on position. Evidence: `diag-pos-role-access` workflow.
- **#103 Outstanding = Revenue** — needs the owner's screenshot (which page). The SO-list KPI is already correct.
- **Add-company** (`docs/add-company-design.md`): needs the account-book/chart-of-accounts template source. Key landmine: `doc-no.ts:159 jePrefixForCompany` hardcodes `companyId===1?'':'2990-'` → company-3 journal entries would mint `2990-…` and collide. Owner wants it "like Hookka ERP" — but Hookka's multi-company is thin (a name registry, everything global); Houzs already isolates more. Reference: `Desktop/Hookka/hookka-main`.

## Known gaps / follow-ups (not yet started)
- **Supplier 404 backend root cause OWED.** Owner insists: in Houzs you should never reach a 2990 supplier; find WHERE a Houzs surface links to a 2990 supplier id (list leak? child row? scorecard?). Data is clean (0 orphan/cross-company per `diag-supplier-reachability`). My #1158 fix only softened the message. When the owner hits it again, get the exact entry page.
- **processing_date column cleanup** — owner: "why so many processing dates?" There is ONE user date = `internal_expected_dd`; `processing_date` is a dead legacy snapshot (confusing), `proceeded_at` is the POS Proceed timestamp (different concept). After the read-fix (`fix/so-processing-date-display`), retire the legacy `processing_date` column so the DB has one too (a migration + code sweep).
- **SELLING & COST surface** — owner still sees "code · description" with no variant on an "ORDER LINES · SELLING & COST" table (LOTTI/XAMMAR). #1174 targets Fair Report; verify that IS the component the owner sees (could be `SalesOrderDetailListing` / a P&L view) and cover it.
- **Price backfill** — after #1167 deploys, run `backfill-product-price-baseline` DRY-RUN → review → apply (reconstructs price dates from `master_price_history`).
- **Pricing phase 3** — order read-integration (`mfg-pricing-recompute.ts` taking the as-of price on the doc date). MONEY-CRITICAL, held for a dedicated CI-verified pass (multiple price paths: catalog sell / sofa module / PWP). NOT done deliberately.
- **#98** Members per-company filter; **#101** email reset — verify Resend config (RESEND_API_KEY + verified EMAIL_FROM) actually delivers (change-password code is done on desktop+mobile).

## Live-test deploy note for the owner
After merging FE PRs, the deploy takes ~5-8 min; the PWA caches — the owner must
HARD REFRESH (`Ctrl+Shift+R`) or use the PWA update banner. Several "you didn't
see it" reports were the unmerged PRs above + PWA cache.

## Housekeeping
Worktrees linger at `Desktop/hz-baseline-worktrees/*` (they block local branch
deletion on merge — remote merge still succeeds). Prune when the agents finish:
`git worktree prune` + `git worktree remove <path>`.

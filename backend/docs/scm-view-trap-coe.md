# SCM VIEW-TRAP — defensive CoE (Houzs port of 2990's 2026-06-26 incident)

**Status:** PREVENTIVE (no Houzs prod incident yet). **Authored:** 2026-06-29.
**Origin:** 2990 prod hit this 2026-06-26 (`docs/2026-06-26-so-list-view-trap-coe.md`)
when a shared SO HEADER select constant was extended with new base-table
columns. Houzs SCM is a 1:1 clone of 2990's furniture SCM, so the SAME class
of bug can land here. This doc captures the pattern + the Houzs-specific
guard so it never does.

---

## 1. The trap, in one paragraph

`scm.mfg_sales_orders_with_payment_totals` is a Postgres VIEW. Postgres
**freezes** a view's output column set at `CREATE VIEW` time — even when the
view body says `SELECT so.*`. After that, an `ALTER TABLE
mfg_sales_orders ADD COLUMN x` does NOT flow through to the view. Any code that
selects `x` via the view gets back `column ... does not exist` → PostgREST 500
→ the SO LIST page renders "Failed to load." for every user.

The fatal shape is:

| Read | Source | Knows new columns? |
|---|---|---|
| SO **detail** GET (`/:docNo`) | `from('mfg_sales_orders')` (BASE TABLE) | YES — `ALTER TABLE` added them |
| SO **list** GET (`/`) | `from('mfg_sales_orders_with_payment_totals')` (VIEW) | NO — view frozen at creation |

When ONE shared `HEADER` SELECT string feeds BOTH reads, adding a column to
HEADER is fatal for the list read unless the view is recreated in the same PR.

---

## 2. Houzs current state (verified 2026-06-29)

- The view was created by `backend/scripts/scm-schema/apply-scm-views.mjs`,
  which pulls 2990's view-creating migrations in numeric order. The LAST one
  it applies for this view is 2990's mig `0155_so_sku_p2_service_bucket_skus_deposit.sql`,
  which DROP + CREATE the view as `SELECT so.*` (plus `paid_total_sen` +
  `balance_sen_live` computed cols). It does NOT apply 2990's later fixes
  (`0193_currencies_master.sql`, `0200_recreate_so_payment_view.sql`,
  `0201_amend_reason.sql`).
- Houzs has since added columns to `scm.mfg_sales_orders` via local migrations
  `0033_so_scan_slip_image.sql` (`slip_image_key`), `0034_so_scan_receipt_image.sql`
  (`receipt_image_key`), and `0053_scm_delivery_planning_tms.sql`
  (`delivery_state`, `possession_date`, `house_type`, `replacement_disposal`,
  `referral`, `amend_date_from_customer`, `amended_delivery_date`,
  `amend_reason`). NONE of these are visible through the view.
- The `HEADER` constant at `backend/src/scm/routes/mfg-sales-orders.ts` does
  NOT reference any of those new columns. **No active drift. No live 500.**
- The detail-only columns (`slip_image_key`, `receipt_image_key`,
  `proceeded_at`, `signature_b64`, `slip_key`, `slip_state`) are appended on
  the BASE-TABLE detail read at the `/:docNo` handler, NEVER on HEADER. That
  is exactly the 2990 pattern (P-2 below).
- `backend/src/scm/routes/delivery-planning.ts` reads the SO header off the
  BASE table `mfg_sales_orders` (safe) and only hits the view for one
  view-native column (`balance_sen_live`). Also safe.

---

## 3. The two at-risk select strings (where inline guards now live)

1. `backend/src/scm/routes/mfg-sales-orders.ts` — the `HEADER` constant
   (definition site) AND the `LIST_COLS` select against the view. Both
   carry an inline `VIEW-TRAP` comment block pointing here.
2. `backend/src/scm/routes/delivery-planning.ts` — the
   `mfg_sales_orders_with_payment_totals` select inside `loadRegionConfig`
   call site. Carries an inline `VIEW-TRAP` comment pointing here.

If a third route grows a view-backed select, copy the comment block from the
first call site and grep for it on review.

> **This rule is still enforced by prose, and that is a known gap — not a
> claim of coverage.** As of 2026-08-13 there are 10 `VIEW-TRAP` comment sites
> in the tree and zero automated checks, and this COE's own family bit twice
> more afterwards (2026-07-24, "Sales Orders list down on prod — permission
> denied for view `mfg_sales_orders_with_payment_totals`", then again after
> 0190). `docs/jsonb-double-encoding-coe.md` Lesson 4 is the general finding:
> a documented trap catches the next reader anyway.
>
> The executable form would be a `test:pg` case (that CI job already runs a real
> postgres:16) that builds the view family from the migrations and asserts every
> column named in the shared HEADER select resolves through the VIEW, not only
> through the base table — Postgres freezes a view's output column set at
> `CREATE VIEW` time even when the body says `SELECT so.*`, which is this whole
> COE. Until that exists, "copy the comment and grep on review" is what there
> is. Tracked in `docs/bug-classes.md` under *Classes with no check yet*.

---

## 4. Prevention rules (Houzs-flavoured P-1..P-5)

**P-1 — Recreate the view in the SAME migration that adds a column you intend
to expose via the view.** Use `CREATE OR REPLACE VIEW
scm.mfg_sales_orders_with_payment_totals AS SELECT so.* …` (preserves grants;
`so.*` re-expands at the recreate, picking up every base-table column at that
moment). The new mig number is just the next free Houzs PG mig number.

**P-2 — Detail-only fields stay OUT of HEADER.** Append them on the BASE-TABLE
detail SELECT only. Houzs already does this for `slip_image_key`,
`receipt_image_key`, `proceeded_at`, `signature_b64`, `slip_key`, `slip_state`,
and the 8 cols from mig 0053 (`delivery_state`, `possession_date`, `house_type`,
`replacement_disposal`, `referral`, `amend_date_from_customer`,
`amended_delivery_date`, `amend_reason`).

**P-3 — `SELECT so.*` is NOT auto-tracking.** It is frozen at the last
`CREATE VIEW` just like an enumerated list. Don't rely on `so.*` to "see"
new columns without a recreate.

**P-4 — When you write `ALTER TABLE scm.mfg_sales_orders ADD COLUMN`, grep for
dependent views.** `grep -rn "FROM scm.mfg_sales_orders\b\|from('mfg_sales_orders_with_payment_totals')" backend/src` → if anything matches, decide:
recreate the view (if the list needs the col) OR keep it detail-only (P-2).

**P-5 — `pg_get_viewdef('scm.mfg_sales_orders_with_payment_totals'::regclass, true)`
is the source of truth.** Don't trust the migration ledger; pg-migrate has had
duplicates (CLAUDE.md). Before assuming a view carries a column, read its live
definition against prod.

**P-6 — RENAMING a base column does not break the view, it makes the view LIE.
Rename the view's output column too, and do NOT drop the view to do it.**
Added by mig **0286** (`internal_expected_dd` → `processing_date`), verified on a
PGlite replica of the base table + view + both grantee roles:

> **This section said "0284" in four places until 2026-08-14, and 0284 is a
> different migration** — it drops `scm.consignment_sales_orders.proceeded_at`
> and touches no view at all. The behaviour described below was always 0286's
> (`0286_scm_processing_date_one_name.sql`, applied to prod
> 2026-08-13T13:46:59Z). Worth recording rather than silently correcting,
> because the wrong number propagated into code: `probe-rename-preconditions.mjs`
> still pins `const MIGRATION = "0284_scm_processing_date_one_name.sql"`, a
> filename that does not exist in `migrations-pg/`, so the pre-flight this COE
> tells you to run names a file nobody can open. Fixing that constant is a code
> change and is not part of this doc pass.

* `ALTER TABLE scm.mfg_sales_orders RENAME COLUMN a TO b` **succeeds** with the
  view in place — Postgres stores the rewrite rule by attribute number, so
  `pg_get_viewdef` afterwards reads `so.b AS a`. No error, no drop, ACL and
  owner untouched.
* The view's own output column is still called `a`. So the base table has `b`,
  the view has `a`, and the first route that selects `b` from the view 500s with
  "column b does not exist". That is the same failure surface as the classic
  trap, arrived at from the opposite direction.
* The fix is `ALTER VIEW scm.… RENAME COLUMN a TO b` — a catalog rename, no
  DROP, so it does **not** re-run the 0189 → 0190 → 0191 grant-loss incident.
  0286 does this as a `pg_class` sweep over `relkind IN ('v','m')` rather than
  naming the one view, because the whole lesson of this COE is that the one view
  gets missed.
* Never reach for DROP VIEW → rename → CREATE VIEW here. That path is P-1's, it
  costs the ACL and the owner, and a rename does not need it.
* **A replica is not prod, and P-5 applies to a rename too.** Everything above
  was established on a PGlite replica built from this repo's own SQL, which
  proves 0286 is consistent with the source tree and nothing more. The sweep
  filters `nspname = 'scm'`, so a view in another schema is renamed by nobody and
  caught by nobody; every step is catalog-guarded, so a mismatched prod turns the
  migration into a silent no-op rather than a red run. Read the live catalog
  first: `.github/workflows/probe-rename-preconditions.yml` →
  `backend/scripts/probe-rename-preconditions.mjs`, read-only, one MATCHES /
  DIFFERS line at the end.

---

## 5. Houzs checklist for any change that touches the shared `HEADER`

- [ ] Did I add a column to `HEADER` in `backend/src/scm/routes/mfg-sales-orders.ts`?
- [ ] Is that column actually exposed by `scm.mfg_sales_orders_with_payment_totals`?
      (`pg_get_viewdef` on prod, or check the LAST recreate-view migration.)
- [ ] If NOT exposed, did I ship a Houzs PG migration in the SAME PR that
      `CREATE OR REPLACE VIEW scm.mfg_sales_orders_with_payment_totals AS
      SELECT so.* …` with the new column on the base table FIRST?
- [ ] If the field is detail-only (UI shows it only on the SO detail page),
      did I append it on the base-table detail read at `/:docNo` instead?
- [ ] Did I apply the view migration BEFORE deploying the route code
      (migrate-before-deploy)?
- [ ] Did I re-verify with `pg_get_viewdef` against staging/prod after applying?
- [ ] If I RENAMED a base column, did I also rename the view's output column
      (P-6), and confirm the view answers to the NEW name — not just that the
      `ALTER TABLE` succeeded? A successful rename is not a working view.
- [ ] Did I read the LIVE catalog before the window — every dependent view with
      its owner and grants, and every other object on the column — rather than
      trusting a replica built from this repo?
      (`probe-rename-preconditions` workflow; it must end in MATCHES.)

---

## 6. Related Houzs files

- `backend/src/scm/routes/mfg-sales-orders.ts` — HEADER + LIST_COLS + detail SELECT
- `backend/src/scm/routes/delivery-planning.ts` — secondary view consumer
- `backend/scripts/scm-schema/apply-scm-views.mjs` — pulls 2990 view defs (the
  origin of the current Houzs view definition)
- `backend/scripts/probe-rename-preconditions.mjs` +
  `.github/workflows/probe-rename-preconditions.yml` — read-only pre-flight that
  asks the LIVE catalog whether 0286's assumptions hold (P-5 / P-6)
- `backend/src/db/migrations-pg/0033_so_scan_slip_image.sql` — added slip_image_key (detail-only)
- `backend/src/db/migrations-pg/0034_so_scan_receipt_image.sql` — added receipt_image_key (detail-only)
- `backend/src/db/migrations-pg/0053_scm_delivery_planning_tms.sql` — added 8 cols (all detail-only, has its own VIEW-TRAP note at lines 8-16)

## 7. Related 2990 references

- `2990s/docs/2026-06-26-so-list-view-trap-coe.md` — original prod incident CoE
- `2990s/packages/db/migrations/0200_recreate_so_payment_view.sql` — the recreate-view hotfix
- `2990s/packages/db/migrations/0201_amend_reason.sql` — the "keep it out of HEADER" pattern

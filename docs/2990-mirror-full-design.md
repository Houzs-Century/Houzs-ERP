# 2990 → Houzs full mirror — design

**Status: PHASES 1-3 ARE SHIPPED AND MOUNTED. This banner said "design only,
no production code exists" long after they were live** — read the tree, not this
line. Five receivers are mounted at `backend/src/index.ts:256,260,265,271,272`
(`so-mirror`, `amendment-mirror`, `customer-mirror`, `staff-mirror`,
`warehouse-mirror`); §3.2's command channel is `scm/lib/amendment-command.ts`,
drained on cron at `index.ts:517`; §4's table shipped as mig
`0127_scm_sync_command.sql`. Risk **R3** further down, still described as "a
latent bug in production today", is what `customer-mirror.ts` was built to
close.
**Date:** 2026-07-16
**Scope (owner-decided):** 全部一次性解決 — mirror the whole system, in one go, actionable
("houzs 的可以啊 可是要开2990的公司啊" — 2990 data tags to the 2990 company; you switch
company in Houzs to see AND act on it). The owner was told twice this is a large build and
may be throwaway at cutover, and chose all-at-once. This document designs to that decision;
it does not relitigate it. Section 7 makes the throwaway cost visible, as instructed.

---

## 0. Ground truth (verified in-tree this session)

Everything below was re-verified against `audit-main` (= Houzs prod main) and the read-only
2990 tree at `C:\Users\User\Desktop\2990s`. Where I could not verify (prod-only state), the
claim is labelled **ASSUMPTION** and appears in the Phase-0 pre-checks.

**The live mirror is one-way and carries only Sales Orders.**
`docs/2990-live-sync/01_outbox_2990.sql` puts triggers on exactly three 2990 tables —
`mfg_sales_orders`, `mfg_sales_order_items`, `mfg_sales_order_payments` — and every row is
enqueued with `entity = 'sales_order'`. `02_worker_2990.sql`'s `drain_so_outbox()` filters
`WHERE status='pending' AND entity='sales_order'` and builds `{docNo, header, items,
payments}`. The receiver `backend/src/scm/routes/so-mirror.ts` touches only those three
tables. Activation SQL: `C:\Users\User\Desktop\APPLY-2990-MIRROR.sql` (224 lines, applied).
62 SOs mirrored, doc-no prefixed `2990-`. A drift sentinel already runs every 30 min
(`.github/workflows/mirror-sentinel.yml`, read-only, alarms by failing the job).

**Everything else was a one-time import and is frozen.**
`backend/scripts/migrate-2990-into-houzs.mjs` has a 33-table `ORDER` array:

```
staff, customers, suppliers, series, categories, products, product_models,
product_fabrics, product_size_variants, warehouses, supplier_material_bindings,
venues, mfg_sales_orders, mfg_sales_order_items, mfg_sales_order_payments,
delivery_orders, delivery_order_items, sales_invoices, sales_invoice_items,
sales_invoice_payments, delivery_returns, delivery_return_items, purchase_orders,
purchase_order_items, grns, grn_items, purchase_invoices, purchase_invoice_items,
purchase_returns, purchase_return_items, inventory_movements, inventory_lots,
inventory_lot_consumptions
```

It is **INSERT-only** — `INSERT ... ON CONFLICT DO NOTHING` with **no conflict target**, no
`DO UPDATE`. It never updates. A re-run after a source edit silently keeps the stale
first-import values. It does **no id remapping**: source `id` values (uuid and integer) are
carried through verbatim; only `company_id` is excluded from the copied column set and
re-stamped. FK checks are disabled for the load (`SET session_replication_role = replica`).
`staff` is special-cased (`NO_CID = { staff: { forceInactive: true } }`): imported with **no
`company_id` at all** and `active = false`, so 2990 staff never appear in Houzs pickers but
historical FK refs still resolve. There is **no `user_id` handling anywhere in the script**.

**Never transferred at all:** `so_amendments`, `so_amendment_lines`, `so_revisions`,
`po_revisions`, quotes, stock_transfers, stock_takes, consignment_*, TMS (trips/trip_stops/
delivery_legs), accounting (journal_entries/payment_vouchers), and 2990's POS layer
(orders/order_items/payments/pos_carts). 2990's schema has ~140 tables; the import covered 33.

**The one `so_amendments` row in Houzs is a hand-copied artifact.** It has no outbox lineage.
Its `requested_by` is a 2990 staff uuid the Houzs app cannot write. It created the false
impression that amendments sync. Verdict in §2 and §4: **delete it**.

**The `staff.user_id = NULL` problem is real.** `backend/src/scm/lib/salesScope.ts`
`resolveSalesScopeIds()` maps a Houzs integer user id → `scm.staff` uuids via `staff.user_id`
(the mig-0066 deterministic row `md5('houzs-user:'||id)::uuid`). Imported 2990 staff have
`user_id = NULL`, so they are never in any Houzs user's subtree → a scoped rep's scope list
never matches a mirrored SO's `salesperson_id` → **a scoped Houzs rep sees zero 2990 rows
today.** Directors (`scm.so.view_all` / `*` → scope `null` = unrestricted) see them all.

**Multi-company is live and further along than the brief implies.** `middleware/companyContext.ts`
resolves `companyId` / `companyCode` / `allowedCompanyIds` / `companies` from an `X-Company-Id`
header (frontend switcher, `frontend/src/lib/activeCompany.ts`), fails open, and degrades to
single-company when unresolved. `scm/lib/companyScope.ts` supplies `scopeToCompany` (per-company
isolation), `scopeToAllowedCompanies` (cross-company TMS), `houzsCompanySql` (ASSR pin),
`stampCompany`, and — importantly — **`companyDocPrefix(c)`, which already returns `2990-` when
company 2990 is active.** Mirrored rows land `company_id = 2`.

### Four findings that change the design

These were not in the brief. Each is verified, and each is load-bearing.

**F1 — Houzs's amendment schema has already diverged from 2990's.** Migration
`0119_scm_so_amendment_header_changes.sql` (dated **today**, 2026-07-16) added
`header_changes jsonb` + `old_header_snapshot jsonb` to `scm.so_amendments` for an owner
ruling ("應該是全部可以 request 啊 然後看有沒有 approval"). 2990's `0210_so_amendments.sql` [external]
has **neither column**. A Houzs-originated amendment carrying a header change is
**unrepresentable in 2990**. This kills any naive row-level bidirectional sync of this table.

**F2 — Approving an amendment mutates the SO, and the mirror would silently revert it.**
`scm/lib/so-revision.ts` `applySoAmendment()` writes `scm.mfg_sales_orders` (header allow-list
`processing_date, customer_delivery_date, customer_state, postcode` + cascades) and
`scm.mfg_sales_order_items` (REMOVE = hard DELETE, ADD = INSERT, SPEC/QTY = UPDATE with an
honest-pricing recompute), then bumps `revision`. If that runs on a **mirrored company-2 SO**,
the next 2990 outbox drain for that doc_no upserts the header and **delete-and-reinserts every
item** (`so-mirror.ts` lines 165-169) — wiping the applied revision with no error, no conflict,
no alarm. **This split-brain is reachable today.** It is the single strongest argument for the
authority model in §3.1.

**F3 — Houzs and 2990 would mint colliding doc numbers in the same space.** `companyDocPrefix(c)`
returns `2990-` under company 2990. Every minter folds it into both the `.like()` fetch and
`nextMonthlyDocNo` — e.g. `mfg-sales-orders.ts:758` does `.like('doc_no', '${p}SO-${yymm}-%')`
then max+1. So a Houzs-side create under company 2990 scans the **mirrored** rows and mints
`2990-SO-2607-063`. Meanwhile 2990 independently mints `SO-2607-063` over its own set → the
mirror prefixes it → `2990-SO-2607-063` → the receiver's `ON CONFLICT (doc_no) DO UPDATE`
**silently overwrites the Houzs-native order.** Two sequences, one namespace, no coordination.

**F4 — the company switch gates reads but NOT mutations.** In `scm/routes/so-amendments.ts`,
`scopeToCompany` appears only on the list (line 67) and detail (line 99) reads. Every mutation
handler — `supplier-confirm` (161), `approve-so` (222), `approve-po` (281), `send` (359),
`reject` (409) — loads by `.eq('id', id)` with **no company filter**. A user active in HOUZS
can approve a company-2 amendment by id. This must be closed before any write path ships.

---

## 1. Decisions

**D1 — Authority: originating-system ownership, no exceptions.** 2990 owns every record it
originates. The mirrored copy in Houzs is **read-only data**. There is no per-entity authority
matrix and no last-write-wins; there is one rule, globally. Argued in §3.1.

**D2 — Actionability via command-mirror, not state-merge.** Houzs never writes a mirrored row.
When the owner clicks Approve in Houzs, Houzs enqueues a **command** that calls 2990's **own
existing API** (`PATCH /so-amendments/:id/approve-so`). 2990 applies it with 2990's business
logic, 2990's RBAC, and 2990's identity. The resulting state change flows back down the
**existing** mirror. The owner gets exactly the UX he asked for; the system gets a single
writer per record. Argued in §3.2.

> **Scoped exception (owner, 2026-07-17) — the Product Maintenance push.** Houzs writes 2990's
> `public.maintenance_config_history` **directly**, with 2990's service-role key. D2's literal
> text still holds (that table is **LOCAL** in §3.4's matrix — it is not mirrored, so no mirrored
> row is written and nothing flows back down), but D2's *principle* — 2990's RBAC, 2990's
> identity, one writer — does not. The exception is granted on one specific finding: 2990's
> `POST /maintenance-config/changes` is an RBAC check followed by a plain INSERT, with **no apply
> engine behind it to reuse**, which is exactly what is not true of `applySoAmendment`. It is
> scoped to that one table for that reason and **is not precedent**. The cost — 2990's
> `WRITE_ROLES` check bypassed (and it was the only gate; RLS is not enabled on the table), and a
> key that bypasses all RLS on 2990's whole database held by the Houzs Worker — is documented in
> `backend/src/scm/lib/bridge-2990.ts`'s header.

**D3 — Never touch the working SO drain.** New entities get a **second, parallel** drain
function on 2990. `drain_so_outbox()` and its `entity='sales_order'` filter are frozen. The
non-negotiable from `00_DESIGN.md` — "POS ↔ 2990 backend link must not break" — extends to the
one sync path that already works.

**D4 — Verbatim identity.** Never remap a uuid or an integer id, matching the import and the
`so-mirror.ts` regression comment ("The old mirror remapped FK/self ids … which matched NO
imported row → FK violation → 500"). Doc-number columns get the `2990-` prefix. This is what
makes commands addressable (§3.5).

**D5 — Houzs mints nothing in 2990's namespace.** Document creation is **blocked** while
company 2990 is active (F3). Consequence: 2990 documents are created in 2990's POS, full stop.
If the owner wants to originate 2990 documents in Houzs, that is a separate decision with a
separate prefix (`2990H-`) — see Q4.

**D6 — Masters mirror first, or everything else 500s.** `staff`/`customers`/`suppliers` are FK
targets. They were a frozen import; a 2990 employee or customer created after the cutover
import does not exist in Houzs. Any mirrored child referencing them fails. This is a
**prerequisite phase**, not a nice-to-have — and it is a latent bug in the *current* SO mirror
(see R3).

**D7 — Inventory mirrors as inert data or not at all.** The ledger is derived. Bidirectional
sync of `inventory_movements` would double-count stock. Even one-way, it is only safe if no
Houzs `scm` trigger recomputes lots on insert — an unverified prod-only fact (Phase-0 pre-check
P2). Said plainly in §2.

**D8 — Kill switches live in the database, not env vars.** A deploy is not a safe emergency
lever on this stack (PWA service-worker cache churn; Hyperdrive cold-start 503s post-deploy;
burst-deploy multiplies both). 2990 already has `sync_config(k,v)`; Houzs gets the mirror of it.
Flipping a row is instant and needs no deploy.

---

## 2. Per-entity inventory and verdict

Verdicts:

- **MIRROR-RO** — one-way 2990 → Houzs, read-only in Houzs.
- **MIRROR+CMD** — MIRROR-RO plus a narrow set of authorized transitions dispatched back to 2990 as commands (§3.2).
- **LOCAL** — never mirrored. Stays in whichever system owns it.
- **DEFER** — mirror is plausible but blocked on a pre-check or an owner ruling; not in this build.

### 2a. The 33 imported tables

| # | Entity | Verdict | Justification |
|---|--------|---------|---------------|
| 1 | `staff` | **MIRROR-RO** | FK target for `salesperson_id`, `requested_by`, `so_approved_by`, `created_by`. Frozen import → post-cutover hires break every child mirror (D6, R3). Keep `active=false` + no `company_id`, matching `NO_CID` — mirrored staff must never enter a Houzs picker. `user_id` stays NULL (§3.6). |
| 2 | `customers` | **MIRROR-RO** | FK target for SO/DO/SI. Same freeze problem. 2990 is a RETAILER with its own customer book; Houzs must never write it. |
| 3 | `suppliers` | **MIRROR-RO** | FK target for PO/GRN/PI. Same. |
| 4 | `series` | **MIRROR-RO** | Catalog. Needed for SO line display fidelity. |
| 5 | `categories` | **MIRROR-RO** | Catalog. |
| 6 | `products` | **MIRROR-RO** | Catalog. **Never write back**: 2990's supplier-cost ⇄ combo/product-cost anchoring is 2990's own model. A Houzs price write would corrupt 2990's cost anchor. |
| 7 | `product_models` | **MIRROR-RO** | Catalog. |
| 8 | `product_fabrics` | **MIRROR-RO** | Catalog. Variant resolution on mirrored SO lines needs it. |
| 9 | `product_size_variants` | **MIRROR-RO** | Catalog. |
| 10 | `warehouses` | **MIRROR-RO** | Warehouse binds at SO line and flows SO→PO→GRN→moves. Read-only, or the binding chain diverges. |
| 11 | `supplier_material_bindings` | **MIRROR-RO** | Feeds MRP/PO derivation. Read-only. |
| 12 | `venues` | **LOCAL** | Already nulled on import (`NULL_COLS`) and re-nulled by the repair pass every run. 2990 venues ≠ Houzs venues; there is no reconciliation. Keep nulling. **Note:** the import *does* load the `venues` table at position 12 while nulling every reference to it — either the comment is stale or the load is dead weight. Flagged, not fixed here. |
| 13 | `mfg_sales_orders` | **MIRROR+CMD** | Live today. Commands: the amendment gates only (§3.2). Direct header/line edits from Houzs stay blocked (F2). |
| 14 | `mfg_sales_order_items` | **MIRROR-RO** | Child, replace-set semantics. Never independently writable — the parent's command channel is the only mutation path. |
| 15 | `mfg_sales_order_payments` | **MIRROR-RO** | **Money.** Never write back. A payment written in Houzs against a 2990 SO would not exist in 2990's books. |
| 16 | `delivery_orders` | **MIRROR-RO** | **DO = stock OUT.** A Houzs-written DO would move 2990's ledger without 2990's FIFO logic. Dangerous — never bidirectional. |
| 17 | `delivery_order_items` | **MIRROR-RO** | Child of the above. |
| 18 | `sales_invoices` | **MIRROR-RO** | **Revenue.** Never write back. SI cancel-revenue hardening is 2990-side logic. |
| 19 | `sales_invoice_items` | **MIRROR-RO** | Child. |
| 20 | `sales_invoice_payments` | **MIRROR-RO** | **Money.** Never write back. |
| 21 | `delivery_returns` | **MIRROR-RO** | DR = stock IN. Ledger-affecting. |
| 22 | `delivery_return_items` | **MIRROR-RO** | Child. |
| 23 | `purchase_orders` | **MIRROR-RO** | PO is a *snapshot* of the SO at processing-lock. `approve-po` re-derives it — and that must happen **in 2990** via the command channel, because `reviseBoundPo`'s received-floor check reads 2990's `received_qty`. |
| 24 | `purchase_order_items` | **MIRROR-RO** | Child. |
| 25 | `grns` | **MIRROR-RO** | **GRN = stock IN.** Ledger-affecting. Never bidirectional. |
| 26 | `grn_items` | **MIRROR-RO** | Child. |
| 27 | `purchase_invoices` | **MIRROR-RO** | **Money.** PI-without-GRN is intentional in this model; do not "repair" from Houzs. |
| 28 | `purchase_invoice_items` | **MIRROR-RO** | Child. |
| 29 | `purchase_returns` | **MIRROR-RO** | PR = stock OUT. Ledger-affecting. |
| 30 | `purchase_return_items` | **MIRROR-RO** | Child. |
| 31 | `inventory_movements` | **MIRROR-RO, DANGEROUS** | **The ledger.** Append-only, *derived* from DO/GRN/DR/PR. Mirroring it one-way is safe **only if** no Houzs `scm` trigger recomputes lots on insert (pre-check P2). Bidirectional sync would double-count stock in both systems. Never write back, under any argument. |
| 32 | `inventory_lots` | **MIRROR-RO, DANGEROUS** | FIFO lots. Derived from movements. Must arrive as **inert data**, not be recomputed. Same pre-check. |
| 33 | `inventory_lot_consumptions` | **MIRROR-RO, DANGEROUS** | Derived. Same. |

### 2b. The never-transferred set

| Entity | Verdict | Justification |
|--------|---------|---------------|
| `so_amendments` | **MIRROR+CMD** | **The point of this build.** Mirror down so the owner sees the pending request; approve/reject via command (§3.2). Houzs's `header_changes` column (F1) has **no 2990 equivalent** — see Q3. |
| `so_amendment_lines` | **MIRROR-RO** | Child, replace-set. Mutated only via the parent's command. |
| `so_revisions` | **MIRROR-RO** | Immutable snapshots produced by 2990's `applySoAmendment`. Arrive as a result, never authored in Houzs. |
| `po_revisions` | **MIRROR-RO** | Same, from `reviseBoundPo`. |
| `quotes` | **DEFER** | Pre-sales, low value, dies at cutover. Not worth the phase. |
| `stock_transfers` / `stock_transfer_lines` | **MIRROR-RO** | Inventory-adjacent. Same danger class as §2a 31-33. Desktop-only in Houzs. |
| `stock_takes` / `stock_take_lines` | **MIRROR-RO** | Same. Desktop-only. |
| `consignment_*` (~15 tables) | **DEFER** | Known schema drift: consignment has **no Drizzle schema** in either tree, so the column set must be audited against PROD `information_schema` before a single row moves. Cannot be designed blind. |
| TMS: `trips`, `trip_stops`, `delivery_legs`, `drivers`, `helpers`, `lorries` | **DEFER** | The *only* genuinely shared module — Houzs's TMS is already cross-company (`scopeToAllowedCompanies`). A Houzs-planned trip covering a 2990 DO is the merge's real prize, but it is a **write** into 2990's operational space and needs its own design + owner ruling. Not a mirror problem. See Q5. |
| `journal_entries`, `journal_entry_lines`, `payment_vouchers`, `pv_allocations` | **MIRROR-RO** | **Money.** Read-only or nothing. |
| `orders`, `order_items`, `payments`, `pos_carts`, `pos_pin_attempts`, `order_lane_history`, `order_slip_events`, `pending_slip_uploads` | **LOCAL** | 2990's POS transactional layer. Dies entirely at cutover. Mirroring it is pure waste. |
| `so_settings`, `so_dropdown_options`, `so_scan_rules`, `so_scan_samples` | **LOCAL** | Config. Houzs has its own. |
| `special_addons`, `sofa_combo_pricing`, `sofa_combo_anchor`, `maintenance_config_history`, `master_price_history`, `fabric_tier_addon_config`, `delivery_fee_config` | **LOCAL** | **Pricing config cannot merge** — established: Houzs's Maintenance config reference is HOOKKA, not 2990, and Houzs unified to ONE price. Mirroring 2990's pricing config would corrupt Houzs costing. Never. |
| `hr_commission_config`, `hr_item_kpi`, `hr_salesperson_profiles` | **LOCAL** | 2990-internal. No Houzs surface. |
| `fabric_library`, `bedframe_*`, `compartment_*`, `size_library`, `bundle_library` | **MIRROR-RO** | Needed so a mirrored SO line's variants **render** rather than showing raw codes. Display fidelity only. |
| `showrooms`, `my_localities`, `state_*`, `mrp_category_lead_times` | **DEFER** | Low value pre-cutover. |
| `mfg_so_audit_log`, `mfg_so_status_changes`, `mfg_so_price_overrides` | **MIRROR-RO** | Audit trail for mirrored SOs. Nice-to-have; sequence after the chain lands. |

**Count:** 33 imported + ~25 newly mirrored = ~58 tables MIRROR-RO, 2 MIRROR+CMD, the rest
LOCAL or DEFER. Of 2990's ~140 tables, roughly **60% never mirror** — mostly POS, pricing
config, and HR. That is the honest shape of "全部".

---

## 3. The three hard mechanisms

### 3.1 Authority and conflict

**Rule: the originating system owns the record, globally. Houzs may perform only specific
authorized transitions, and never by writing the row.**

*Argued for, as the brief invites.* The alternative — per-entity authority, or last-write-wins
on a timestamp — fails concretely here, and F2 is the proof. `applySoAmendment` on a mirrored
company-2 SO writes the header and delete-and-reinserts the lines. The next 2990 drain for that
doc_no does the same thing with 2990's values. Whoever lands second wins, and the loser's write
vanishes with **no error, no conflict marker, and no sentinel alarm** — the sentinel counts rows,
and the row count is unchanged. A timestamp tiebreak does not help: the mirror carries 2990's
`updated_at`, so 2990 always looks newer than a Houzs edit made seconds earlier.

Per-entity authority fails for a second, independent reason: F1. Houzs's amendment schema has
already drifted (`header_changes`). Two schemas that are not the same shape cannot be reconciled
by a merge rule — there is no correct value to merge *into* on the 2990 side. Any per-entity
"Houzs owns amendments" rule would mean 2990's amendment table is no longer the source of the
data its own `applySoAmendment` reads. That is not an authority model; it is a fork.

**So: what happens on a genuine concurrent edit?** Under this design, **it cannot occur**, and
that is the design's main claim. There is exactly one writer per record — 2990. A Houzs
"approval" is not a write; it is a request to 2990 to perform a transition. If 2990 has already
performed it (a coordinator approved in the POS two seconds earlier), 2990's **own state machine**
rejects the command with `409 bad_transition` — the guard is already there
(`apps/api/src/routes/so-amendments.ts:227`, `canTransition(amendment.status, action)`). We
convert that 409 into a converged outcome, not an error (§3.3). The state machine we would
otherwise have to invent for conflict resolution **already exists in 2990** and is already
authoritative. We are not building a conflict resolver; we are declining to create the conflict.

**Cost of this position, stated honestly:** Houzs cannot do anything to 2990 data that 2990's
API does not already expose as an endpoint. If the owner wants an action in Houzs that 2990's
API has no route for, it cannot be built without touching 2990's code — which D3 and the
shared-live-tree constraint forbid. That is a real ceiling. It is also the correct ceiling: the
things 2990's API does not expose are exactly the things 2990's business logic was never
designed to have done to it from outside.

### 3.2 The write-back path (the return channel)

**Transport.** Houzs Worker → HTTPS → **2990's existing production API**. No new 2990 code, no
new 2990 route, no direct database write. `PATCH /api/so-amendments/:id/approve-so`,
`/approve-po`, `/send`, `/reject`, `/supplier-confirm` — all five gates already exist
(`apps/api/src/routes/so-amendments.ts` lines 134/205/272/370/425) and all five already run
their own RBAC, their own `canTransition` guard, and their own apply engine.

Writing to 2990's **database** instead was considered and rejected: `applySoAmendment` is not a
row write, it is a snapshot + line diff + honest-pricing recompute + delivery-fee re-derive +
revision bump. Reimplementing that from Houzs would fork the pricing engine. Calling the API
reuses it.

**Auth.** 2990's API reads `c.get('user')` from a Supabase JWT and gates on
`isApproveSoCaller(sb, user.id)`. So the bridge needs a **real 2990 Supabase auth user with a
real `public.staff` row** carrying a role that passes that gate (coordinator / showroom_lead /
admin+). The Supabase **service-role key must not be used**: it carries no user identity, so
`user.id` would be undefined and the RBAC check would fail anyway. Houzs stores
`BRIDGE_2990_EMAIL` / `BRIDGE_2990_PASSWORD` as Worker secrets, exchanges them for a JWT, and
caches it for the isolate lifetime with refresh-on-401.

> **Scope note (2026-07-17).** The paragraph above is about **this** path — the amendment
> write-back — and remains true for it: the service-role key genuinely cannot call these
> endpoints, because it fails their staff lookup rather than bypassing it. It is **not** a
> statement about 2990's whole API. The Product Maintenance push (D2's scoped exception) does not
> call an endpoint at all; it writes its one table directly with the service-role key, which
> works precisely because it never goes through GoTrue or a staff lookup. Neither the bridge auth
> user nor `BRIDGE_2990_EMAIL` / `BRIDGE_2990_PASSWORD` exist yet — they are still to be created
> when this path is built.

This is a **data change in 2990, not a code change** — one auth user, one staff row. It respects
the shared-tree constraint. It needs the owner to create it or to authorize IT to (Q2).

**Idempotency.** Two layers.
1. `scm.sync_command.idempotency_key` — `sha256(entity|entity_key|action|target_status)`, unique
   index. The same decision cannot be enqueued twice.
2. **2990's state machine is the real idempotency guard.** On retry, if 2990 already applied the
   command, it returns `409 bad_transition`. We then **read the amendment's current status back**;
   if it is at or past the target status, the command is `DONE (converged)`, not failed. This is
   the mechanism that makes the lost-response case (below) safe.

**Ordering.** Per-`so_doc_no` serialization: the dispatcher takes only the **oldest pending
command per `so_doc_no`** and will not dispatch the next for that SO until the prior is
terminal. Natural, because 2990's `uq_so_amendment_open` partial unique index already permits
only one open amendment per SO — so cross-amendment ordering within an SO is not a real scenario.
Across different SOs, order does not matter (no shared state).

**Retry.** Immediate attempt inline via `ctx.waitUntil` (precedent: the scan background job's
`/scan-so/enqueue` → `waitUntil` → DRAFT), so the happy path is sub-second and interactive.
Backstop sweep every 5 min via a GitHub Action (precedent: `mirror-sentinel.yml`) with
exponential backoff and `attempts` / `last_error` columns, mirroring the outbox's own shape.
`attempts > 10` → status `FAILED`, surfaced to the owner. Houzs has no Cron Trigger on this
Worker today; adding one is possible but a GH Action matches existing practice and needs no
deploy-time change.

**The split-brain case — write-back FAILS after Houzs-side state already changed.**
Under this design **the Houzs-side state does not change first.** That is the whole point, and
it is why the case mostly dissolves:

- The owner clicks Approve. Houzs writes a `sync_command` row (`PENDING`) and **does not touch**
  `scm.so_amendments`. The UI shows the amendment as *Approving…* — derived from the command
  row, not from a mutated amendment status.
- 2990 applies → its triggers enqueue → the mirror pushes the new state down → Houzs's mirrored
  `so_amendments.status` becomes `SO_APPROVED` **because 2990 says so**. The command flips to
  `DONE`. Convergence is by the mirror, not by a local write.
- **Network failure / 2990 down:** command stays `PENDING`, retries. Houzs still shows
  *Approving…*. Nothing has diverged, because nothing was written.
- **2990 rejects (409 bad_transition):** command → `DONE (converged)` if the amendment is already
  at/past the target (someone approved in the POS first — the mirror will show that), else
  `FAILED` with a plain-language message per the standing rule: *"2990 那边已经处理过这个修改了。"*
- **The one true split-brain window — 2990 applied it but the HTTP response was lost.** Houzs
  believes `PENDING`, 2990 believes `SO_APPROVED`. Resolution: the retry fires, 2990 returns 409,
  we read status back, see `SO_APPROVED` = the target → `DONE (converged)`. **And independently**,
  2990's apply already enqueued an outbox row, so the mirror pushes `SO_APPROVED` down within
  seconds regardless of the command's fate. The divergence window is bounded by the drain
  interval (~10s), self-heals through **two** independent paths, and never produces a wrong value
  — only a briefly stale one.
- **The residual, stated plainly:** if the command dispatcher is wedged *and* the mirror is
  wedged, Houzs shows a stale amendment status indefinitely. That is a **stall, not a corruption**
  — and it is exactly what the sentinel already alarms on. A stall the owner can see beats a
  silent wrong number.

Compare the rejected design (Houzs writes locally, then pushes the row back): a failed push
leaves Houzs `SO_APPROVED` and 2990 `SUPPLIER_PENDING`, both believing they are right, with the
SO's lines and prices **actually different** in the two systems, and the next 2990 drain
overwriting Houzs's version (F2). That is unrecoverable without a manual diff. This is the
concrete reason for D2.

### 3.3 Loop prevention

**The invariant: only 2990 has an outbox; only Houzs has a command queue; neither consumes its
own output.** Data flows 2990 → Houzs. Commands flow Houzs → 2990. Houzs's receiver
(`so-mirror.ts` and its successors) emits nothing. So the cycle is:

```
2990 change → outbox → drain → Houzs receiver → [STOP: no outbox in Houzs]
Houzs approve → sync_command → 2990 API → 2990 change → outbox → drain → Houzs receiver → [STOP]
```

Depth is **1** and terminates by construction. The second line is not a loop — it is the ack.
The mirror push *is* how Houzs learns the command succeeded.

**Defence in depth (and the marker the brief asks for), for the case where the owner later wants
true row-level write-back:** add `origin TEXT NOT NULL DEFAULT '2990'` to 2990's `sync_outbox`;
the trigger reads a session GUC — `COALESCE(current_setting('app.sync_origin', true), '2990')` —
and the drain skips `WHERE origin <> 'houzs'`. A bridge-originated write would `SET LOCAL
app.sync_origin = 'houzs'` in its transaction, so the trigger tags the row and the drain declines
to echo it back. **We do not need this under D2** — the bridge never writes 2990's DB directly,
and a command-induced change *should* mirror down. It is specified here so that if Q4 (Houzs
originating 2990 documents) is ever a yes, the marker is designed rather than improvised.

Echo-suppression is additionally **free** on the Houzs side: the receiver is a pure upsert with
no side effects and no triggers of its own (verified: the only trigger in `migrations-pg` is
`trg_sync_user_to_staff` from mig 0066, on `public.users`, unrelated). **ASSUMPTION** — prod may
carry the 12 restored `scm` PL/pgSQL functions + 2 triggers that are not in the migration tree.
Pre-check P2.

### 3.4 Doc-no and identity, per entity

| Entity class | Identity rule |
|---|---|
| Doc-numbered headers (`mfg_sales_orders.doc_no`, `delivery_orders.do_number`, `sales_invoices.invoice_number`, `purchase_orders.po_number`, `grns.grn_number`, `purchase_invoices.invoice_number`, `delivery_returns.dr_number`, `purchase_returns.pr_number`) | `2990-` + source value. Existing `prefixDoc` / `DOCNO_COL` rule. |
| Doc-no reference columns (`mfg_sales_order_items.doc_no`, `mfg_sales_order_payments.so_doc_no`, `delivery_orders.so_doc_no`, `inventory_*.source_doc_no`, `mfg_sales_orders.cross_category_source_doc_no`) | `2990-` + source value. Existing `PREFIX_REF_COLS`. **Audit gap:** `delivery_order_items`, `sales_invoice_items`, `purchase_order_items`, `grn_items` etc. have no entry — correct only if they join by integer id, not doc-no string. Pre-check P4. |
| **`so_amendments.so_doc_no`** | `2990-` + source. **Required** — it FKs to `mfg_sales_orders(doc_no)` ON DELETE CASCADE, and the mirrored parent is prefixed. Unprefixed = FK violation. |
| **`so_amendments.amendment_no`** | `2990-SO-2607-006/A1` — i.e. prefix flows through, since 2990 mints it as `${so_doc_no}/A${n}`. The hand-copied row's bare `SO-2607-006/A1` is **wrong** and is why it looked like a sync artifact. |
| `so_revisions.so_doc_no` | `2990-` + source. (No FK in Houzs — verified — but the unique `(so_doc_no, revision)` must agree with the parent's prefixed identity or lookups miss.) |
| `po_revisions.po_id` | uuid, verbatim. |
| uuid PKs (`so_amendments.id`, `staff.id`, `customers.id`, …) | **Verbatim. Never remap** (D4). Collision probability ≈ 0; remapping is the documented cause of the previous mirror's FK-violation 500s. |
| integer PKs | **Verbatim** — but the id space must be proven non-overlapping with Houzs-native rows per table before that table mirrors (pre-check P3). The import's bare `ON CONFLICT DO NOTHING` **silently drops** a colliding row and its reconcile count (`count(*) WHERE company_id=cid`, cumulative) would not reveal it. |

**How a Houzs-side write maps back to 2990's identifier space: it doesn't need to.** A command
carries the **verbatim 2990 uuid** (`so_amendments.id`) as its target. Because D4 forbids
remapping, the id Houzs holds *is* the id 2990 holds — `PATCH /api/so-amendments/<that uuid>/approve-so`
addresses the right row with no translation table, no reverse map, and no drift. **The verbatim
rule and the command channel are the same decision viewed twice.** This is the design's tidiest
property and the reason D4 is not merely inherited convention.

**F3 mitigation (the collision):** under company 2990, Houzs blocks document creation (D5). The
`companyDocPrefix` machinery stays — it is correct and needed post-cutover — but no Houzs minter
may run in the 2990 namespace while 2990's own minter is live. Enforcement: a guard in the
create handlers, plus the reads/writes gate from F4. If Q4 is ever a yes, Houzs-native 2990
documents take a **distinct prefix** (`2990H-`) so the two sequences never share a namespace.

### 3.5 The `staff.user_id = NULL` problem — whose id is stamped, and does it survive?

Traced end-to-end:

**In Houzs.** `gateActorStaffId(sb, c.get('houzsUser')?.id, user.id)` (`so-amendments.ts:45`)
resolves the caller's **real** Houzs user id → their mig-0066 `scm.staff` uuid
(`md5('houzs-user:'||id)::uuid`) via `staff.user_id`, falling back to the SCM bridge's **single
pinned super_admin staff row** shared by every caller when the sync row is missing.

**Does it survive the round trip? No — and it must not be attempted.** That uuid is a
Houzs-manufactured id. It does **not** exist in 2990's `public.staff`. 2990's
`so_amendments_so_approved_by_staff_id_fk` (verified in `0210_so_amendments.sql` [external]) would reject
it outright. Any design that writes the Houzs approver's staff uuid into 2990 **fails on the
foreign key** — this is not a stylistic concern, it is a hard constraint.

**Resolution under D2:** the command is applied **by 2990, as 2990's bridge user**. So:

- **In 2990:** `so_approved_by` = the bridge service account's `public.staff` uuid. It reads as
  *"Houzs Bridge"*. The real human's name is carried in the command's note/ref payload where the
  endpoint accepts one, and in 2990's own audit trail.
- **In Houzs:** the **authoritative** record of who approved is `scm.sync_command.requested_by`
  (the real Houzs integer user id) plus `scm.mfg_so_audit_log` via `recordSoAudit`, whose
  `actorName` already carries the real name from `user.user_metadata.name`.
- **After the mirror pushes back:** Houzs's mirrored `so_approved_by` shows the **bridge staff
  uuid**, because that is what 2990 stores. The UI must therefore render the approver from the
  **command row**, not from the mirrored column, for company-2 amendments.

That last point is the honest cost: **the mirrored column lies about the approver, and the UI
must know not to trust it.** The truth is recoverable (command row + audit log) but it is not in
the column a reader would naturally look at. The alternative — a 2990 staff row per Houzs
approver — means syncing Houzs users *into* 2990, which is the User Management merge (Phase 0f),
out of scope here, and would drag 2990 into depending on Houzs. Q6.

**Note, separately:** `so_revisions.created_by` / `po_revisions.created_by` are stamped with the
**pinned bridge uuid** even for native Houzs amendments (`applySoAmendment(sb, id, user.id, c)`
passes `user.id`, not the resolved caller) — those columns have no FK so nothing forced the
issue. Pre-existing Houzs defect, out of scope, worth logging in `BUG-HISTORY.md`.

### 3.6 Company scoping — does the switch gate reads AND writes?

**Reads: yes.** `scopeToCompany` on list (`so-amendments.ts:67`) and detail (`:99`);
`salesDocOutOfScope` on detail; the per-company pattern is consistent across SCM.

**Writes: no — and this is a gap that must close before any command path ships (F4).** Every
mutation handler loads `.eq('id', id)` with no company predicate. A HOUZS-active user can
approve a company-2 amendment by id. **Required fix:** a shared
`assertActiveCompany(row, c)` helper applied to all five amendment mutation handlers, returning
404 (not 403 — indistinguishable from a nonexistent row, matching `salesDocOutOfScope`'s
convention). This is a **code** change, no migration.

**What should a scoped (non-director) rep see?** Today: **nothing** in company 2990 — imported
2990 staff have `user_id = NULL`, so they are in no Houzs user's `manager_id` subtree, so
`resolveSalesScopeIds` returns a list that never matches a mirrored `salesperson_id`. Directors
(`view_all` → `null`) see everything.

**Recommendation: keep it.** It is coherent, it is the current behaviour, and it costs zero
code. The gate for 2990 is the **company grant** (`user_companies`, Phase 0e) — a director-level
grant. Within 2990, the sales-scope rule then yields *everything* for directors and *nothing*
for reps. A Houzs rep has no 2990 downline, so "nothing" is the correct answer, not a bug.

Making a 2990 *salesperson* see their own orders in Houzs would require linking `staff.user_id`
for 2990 staff → creating Houzs users for 2990 staff → the User Management merge. Out of scope.
Q7. **Do not "fix" this by widening the scope rule** — that would grant every Houzs rep sight of
the entire 2990 book, which is strictly worse than nothing.

---

## 4. Schema changes

Repo rules honoured: additive, idempotent, re-run-safe, **no `DO $$` blocks and no
dollar-quoting** (the `pg-migrate` runner splits each file on `;\n` and would fragment them —
documented in `0119`'s header), schema-qualified `scm.*`, and **never pushed until ready** (CI
auto-applies `migrations-pg/` to PROD on every deploy; a failed file blocks all deploys).

### Houzs — two new migrations, both purely additive

**`0120_scm_sync_command.sql` [external]** — the command queue (the return channel's durable state).

```sql
CREATE TABLE IF NOT EXISTS scm.sync_command (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity          text NOT NULL,          -- 'so_amendment'
  entity_key      text NOT NULL,          -- the VERBATIM 2990 uuid (D4)
  action          text NOT NULL,          -- 'approve-so' | 'approve-po' | 'send' | 'reject' | 'supplier-confirm'
  target_status   text,                   -- expected post-state, for the 409-converged check
  payload         jsonb,                  -- endpoint body (reason / ref / note)
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',  -- PENDING|SENT|DONE|CONVERGED|FAILED
  requested_by    bigint,                 -- REAL Houzs public.users id — the authoritative approver (§3.5)
  company_id      bigint,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_command_idem ON scm.sync_command (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_sync_command_pending ON scm.sync_command (created_at) WHERE status IN ('PENDING','SENT');
CREATE INDEX IF NOT EXISTS idx_sync_command_entity ON scm.sync_command (entity, entity_key);
```

`gen_random_uuid()` is already the default on the four 0080 tables, so pgcrypto is present.

**`0121_scm_sync_config.sql` [external]** — the DB-row kill switch (D8), mirroring 2990's `sync_config`.

```sql
CREATE TABLE IF NOT EXISTS scm.sync_config (k text PRIMARY KEY, v text NOT NULL);
```

Seeded out-of-band (not in the migration — per the repo rule that data belongs in scripts):
`mirror_commands_enabled = 'false'`, `mirror_entities_enabled = 'sales_order'`.
**Default OFF.** The feature ships dark and is enabled by flipping a row.

**Nothing else is needed on the Houzs side.** `scm.so_amendments` / `so_amendment_lines` /
`so_revisions` / `po_revisions` already carry a nullable `company_id` (mig 0080 lines 112-115,
verified) with indexes. The amendment mirror needs **no new columns**. A "this row is a mirror"
marker is unnecessary — `company_id = <2990>` already answers it, and the FE already knows the
active company.

### Houzs — one one-shot script (NOT a migration)

**`backend/scripts/purge-handcopied-amendment.mjs`** — deletes the single hand-copied
`so_amendments` row. Per the repo rule, data changes are scripts, not numbered migrations.

*Verdict on that row: delete it.* It has no outbox lineage, its `amendment_no` is bare
(`SO-2607-006/A1`) where the rule requires `2990-SO-2607-006/A1` (§3.4), and its `requested_by`
is a 2990 staff uuid the Houzs app cannot write. Keeping it is actively harmful in two ways:
if its `so_doc_no` is the prefixed one it will **collide with `uq_so_amendment_open`** when the
real row arrives from the backfill (one open amendment per SO) and stall the mirror; if it is
bare it is an **orphan** against the `so_doc_no → mfg_sales_orders(doc_no)` FK. Either way it
must go before Phase 2's backfill, which will re-create it correctly if 2990 still has it open.

### 2990 — applied by hand, additive, parallel to the live path (D3)

Delivered as a reviewable `APPLY-2990-MIRROR-PHASE-N.sql` per phase, applied via the Supabase
SQL editor / Management API exactly as `APPLY-2990-MIRROR.sql` was. **`drain_so_outbox()` and
the `entity='sales_order'` triggers are not touched.**

1. `ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT '2990';`
   (§3.3 defence-in-depth; inert under D2.)
2. New triggers per entity family, each reusing the **existing** exception-swallowing pattern
   from `enqueue_so_outbox_child` — an outbox failure must never block a POS write.
   Phase 1: `staff`, `customers`, `suppliers`. Phase 2: `so_amendments`, `so_amendment_lines`,
   `so_revisions`. Phase 5: the rest of the chain.
3. **A new** `drain_entity_outbox(batch int)` with a per-entity payload builder and its own
   `cron.schedule('entity_outbox_drain', ...)`, plus `confirm_entity_outbox()`. The existing SO
   drain keeps running untouched alongside it.
4. `sync_config` gains `enabled_entities` (CSV), read by the **new** drain only. Kill switch:
   set it to `''` → the new drain no-ops → the SO mirror is unaffected.
5. Bridge service account: one Supabase auth user + one `public.staff` row with an
   approve-capable role (§3.2). **Data, not code** — owner-authorized (Q2).

**Idempotency of all of the above:** `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` — the same re-run-safe
pattern the applied `01_outbox_2990.sql` already uses.

---

## 5. Phased rollout

Owner rule honoured: migrations/backfills go to **STAGING first**, prod only after verified.
Every phase has an independent kill switch and a verification gate. **No phase begins until the
prior phase's soak is green.**

### Phase 0 — pre-checks (read-only, no writes, blocks everything)

| # | Pre-check | Why it blocks |
|---|---|---|
| **P1** | Confirm `pg_cron` + `pg_net` are still healthy on 2990 prod and the SO drain is delivering (`SELECT status, count(*) FROM sync_outbox GROUP BY 1`). | The whole transport assumes them. |
| **P2** | `SELECT * FROM information_schema.triggers WHERE trigger_schema='scm'` on **Houzs PROD**. | **The single most dangerous unknown.** The 12 restored PL/pgSQL fns + 2 triggers are not in `migrations-pg` — they were applied out-of-band. If a trigger recomputes lots/balances on an `inventory_movements` insert, mirroring 2990's movements **doubles the ledger in Houzs**. If it fires, §2a rows 31-33 become **DEFER**, not MIRROR-RO. |
| **P3** | Per integer-PK table, prove the 2990 id space does not overlap Houzs-native rows. | The import's bare `ON CONFLICT DO NOTHING` silently drops collisions and the cumulative reconcile count hides it. |
| **P4** | Confirm `delivery_order_items` / `sales_invoice_items` / `grn_items` / `purchase_order_items` join by integer id, not doc-no string. | If any joins by doc-no, `PREFIX_REF_COLS` has a hole and those children mis-link (§3.4). |
| **P5** | **Get the cutover date from the owner.** | §7. Determines whether this build has positive value at all. |

### Phase 1 — masters (STAGING) — *the FK prerequisite*

`staff`, `customers`, `suppliers` mirror. Keep `staff` at `active=false`, no `company_id`
(matching `NO_CID`), `user_id` NULL (§3.6).
**Verify:** create a new customer + a new staff member in a 2990 stand-in → both appear in
Houzs staging within ~15s; `staff` does not appear in any Houzs picker.
**Kill switch:** `sync_config.enabled_entities = ''`.

### Phase 2 — amendments, read-only (STAGING)

`so_amendments` + `so_amendment_lines` + `so_revisions` mirror down. Run the purge script first.
**Verify:** raise an amendment in the 2990 stand-in → the owner sees it in Houzs staging under
company 2990 with correct `2990-SO-…/A1` identity, correct requester name, correct line diffs.
Approve it **in 2990** → Houzs reflects `SO_APPROVED` + the revised lines within ~15s.
**This phase alone delivers most of the owner's visibility ask, with zero write risk.**

### Phase 3 — the command channel (STAGING)

Close F4 first (`assertActiveCompany` on all five mutation handlers) and D5 (block creation under
company 2990). Then: `scm.sync_command`, the dispatcher, the bridge account, the UI *Approving…*
state.
**Verify, explicitly:**
- Happy path: approve in Houzs → 2990 applies → mirror reflects it. Sub-second to seconds.
- **409-converged:** approve in 2990 first, then in Houzs → command lands `CONVERGED`, no error shown.
- **Lost response:** kill the dispatcher after dispatch → retry → `CONVERGED`; and independently
  confirm the mirror already pushed the truth down.
- **2990 down:** command stays `PENDING`, UI stays *Approving…*, nothing diverges; recovers on retry.
- **Permission:** a non-approver cannot enqueue; a HOUZS-active user cannot approve a company-2 row.
**Kill switch:** `scm.sync_config.mirror_commands_enabled = 'false'` → dispatcher no-ops, UI hides
the button. Mirror unaffected.

### Phase 4 — Phases 1-3 to PROD, in sequence, each with a soak

One phase per deploy. **Never burst-deploy** (PWA service-worker cache; Hyperdrive cold-start
503s). 24h soak between phases, sentinel green throughout. Commands ship **dark**
(`mirror_commands_enabled='false'`) and are flipped on only after the mirror side is proven quiet.

### Phase 5 — the rest of the chain, read-only (STAGING → PROD)

DO / SI / DR / PO / GRN / PI / PR, then — **only if P2 is clean** — inventory. Order matters:
parents before children, masters already done.

### Phase 6 — DEFER set

Consignment (needs the `information_schema` drift audit first), TMS (needs its own design + owner
ruling), accounting, audit logs. Not in this build.

### Verification, throughout

Extend `backend/scripts/mirror-drift-sentinel.mjs` to count parity **per entity**, not just SOs.
Add a command-queue alarm: any `sync_command` in `PENDING`/`SENT` for > 15 min, or any `FAILED`.
Reuse the existing failed-workflow-email alarm — it is the only notifier that exists today.

---

## 6. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | **A Houzs `scm` trigger recomputes the ledger on a mirrored `inventory_movements` insert → stock doubles in Houzs.** | **Critical** | Pre-check P2 **before any inventory phase**. If it fires, inventory becomes DEFER. Not negotiable. |
| **R2** | **F2 is live today.** A director can approve the hand-copied amendment right now; `applySoAmendment` would mutate the mirrored company-2 SO, and the next 2990 drain would silently revert it. | **High, present** | The purge script (Phase 2) removes the only reachable instance. `assertActiveCompany` (Phase 3) closes the class. Arguably worth shipping the purge **ahead of** the whole build. |
| **R3** | **The current SO mirror is already fragile.** A 2990 customer created after the cutover import does not exist in Houzs; a mirrored SO referencing it fails the FK → receiver 500 → outbox retries forever → sentinel alarms. **This is a latent bug in production today**, independent of this design. | **High, present** | Phase 1 (masters) fixes it. This alone may justify Phase 1 regardless of the rest. Verify whether `scm.mfg_sales_orders.customer_id` actually carries an FK in the pure-DDL port — if the port dropped FKs, the failure mode is a **dangling reference** instead (worse: silent). |
| **R4** | **F3 doc-no collision** — Houzs and 2990 mint the same `2990-SO-YYMM-NNN`; the mirror's upsert silently overwrites the Houzs-native order. | **High** | D5: block creation under company 2990. If Q4 is yes, `2990H-` prefix. |
| **R5** | **F1 schema drift widens.** Houzs's amendment table gained `header_changes` today. More drift = more of 2990's surface unrepresentable. | **Medium, growing** | D1/D2 contain it (2990 stays authoritative), but drift makes the mirrored view progressively less faithful. Q3. |
| **R6** | **No transaction anywhere in `applySoAmendment`.** A mid-sequence failure leaves an SO half-amended, revision un-bumped. Pre-existing Houzs (and 2990) defect. | **Medium** | Out of scope, but under D2 it becomes **2990's** problem on 2990's data — which is where it already was. Log in `BUG-HISTORY.md`. |
| **R7** | **The bridge account is a standing privileged credential into 2990 prod.** | **Medium** | Least-privilege role (approve gates only, not admin). Secrets in Worker secrets, never in the tree. Rotatable. Its every action is attributable in `sync_command.requested_by`. |
| **R8** | **The approver column lies** (§3.5) — mirrored `so_approved_by` reads "Houzs Bridge". | **Low, permanent** | UI renders the approver from `sync_command` for company-2 rows. Documented, not fixed. |
| **R9** | **Scale.** ~58 tables × triggers × a 10s drain on 2990 prod. The SO drain handles 3 tables today. | **Medium** | Phase it; batch limit stays 50; watch 2990 DB load at each phase. The triggers are exception-swallowing and same-tx — cheap — but 58 of them on a POS-critical DB is not nothing. |
| **R10** | **Consignment drift** — no Drizzle schema in either tree; phantom columns vs PROD. | **Medium** | DEFER until audited. Do not design blind. |

### 7. What is throwaway at cutover — made visible, not argued

The owner has accepted this cost. Stating it precisely so it is a known number rather than a
surprise.

**100% throwaway when 2990's POS retires into the merged DB:**

- All 2990-side sync machinery: `sync_outbox`, `sync_config`, ~58 triggers, `drain_so_outbox()`,
  `drain_entity_outbox()`, `confirm_*()`, both `pg_cron` schedules, `pg_net` dependency.
- All Houzs-side receiver code: `backend/src/scm/routes/so-mirror.ts` and every new mirror route.
- The **entire command channel**: `scm.sync_command`, the dispatcher, the retry sweep, the
  bridge service account, the `Approving…` UI state, the 409-converged logic. **This is the
  largest single piece of net-new work in the build, and it is the most completely thrown away** —
  post-cutover, an approval is just a local write.
- `mirror-sentinel.yml`, `mirror-drift-sentinel.mjs`, `migrate-2990.yml`, `rollback-2990.yml`,
  `diag-2990.yml`, `docs/2990-live-sync/*`, `APPLY-2990-MIRROR*.sql`.
- The `2990-` doc-no prefix **as a mirror rule** (it survives as a *numbering* rule — see below).
- `assertActiveCompany` — no; that one survives (it is a multi-company rule, not a mirror rule).

**Survives cutover:**

- The **data**. Mirrored rows become the real rows. No re-import — this is the mirror's most
  durable contribution and the reason Phase 1's masters have value beyond this build.
- The multi-company foundation: `company_id`, `companyContext`, `companyScope`, `user_companies`,
  `companyDocPrefix` (still needed — per-company numbering is permanent), the TMS
  cross-company pattern.
- The F4 fix (`assertActiveCompany`) — a genuine multi-company correctness fix that should
  arguably ship on its own merits regardless of this build.
- Whatever the mirror surfaces in the meantime: the owner's live merged view.

**The honest calculus.** The mirror's product is **time** — a live merged view for however many
months remain until cutover. Roughly **80% of the net-new code is throwaway**; the surviving 20%
is the multi-company scaffolding that is already largely built, plus two fixes (F4, R3) that
stand on their own.

Therefore: **the single most decision-relevant fact is the cutover date** (P5/Q1). At 12 months
out, this build is clearly worth it. At 2 months, the build will not finish before its own
obsolescence and would consume the engineering that cutover itself needs. This is not an argument
against the owner's decision — it is the one input that decides whether the decision's premise
holds, and it costs him one sentence to answer.

**A cheaper option exists and should be named, once, without pressing:** Phases 0-2 alone
(masters + amendments, read-only) give the owner *visibility* of 2990 amendments in Houzs at
roughly **a quarter of the cost and near-zero risk**, and fix the live R3 bug. Only Phase 3 (the
command channel) buys *actionability* — and Phase 3 is the expensive, most-throwaway part. If the
answer to Q1 is short, Phases 0-2 are the build. The owner asked for actionable and I have
designed actionable; this is offered as a fallback, not a counter-proposal.

---

## 8. Open questions for the owner

Ordered by how much they change the design.

1. **When does 2990's POS retire into the merged DB?** (P5) The one input that determines whether
   the full build or Phases 0-2 is correct. Even "roughly — this year or next?" is enough.
2. **May IT create a bridge service account in 2990 prod?** One Supabase auth user + one `staff`
   row with an approve-capable role. **Data, not code — 2990's tree is not touched.** Phase 3
   cannot exist without it. (Q2)
3. **Amendments: approve-only, or also create?** The brief says "approve an amendment". If the
   owner also wants to *raise* a 2990 amendment from Houzs, note that Houzs's `header_changes`
   (mig 0119, today) has **no 2990 equivalent** — a header-change request made in Houzs is
   unrepresentable in 2990 and could not be applied there. Approve-only sidesteps this entirely. (Q3)
4. **Should Houzs be able to create 2990 documents (SO/DO/PO) at all?** Default answer in this
   design: **no** (D5) — F3's collision makes it unsafe without a separate `2990H-` prefix. If
   yes, that is additional work and the loop-marker in §3.3 becomes load-bearing. (Q4)
5. **TMS: should a Houzs-planned trip cover a 2990 DO?** This is the merge's real prize and the
   only genuinely shared module — but it is a write into 2990's operational space and needs its
   own design. Deferred here. Worth a yes/no on whether to design it next. (Q5)
6. **Is "Houzs Bridge" acceptable as the approver name shown inside 2990?** (§3.5) The real human
   is recorded on the Houzs side and in the note field, but 2990's own screen will read "Houzs
   Bridge". The alternative is syncing Houzs users into 2990 — the User Management merge. (Q6)
7. **Should a 2990 salesperson be able to log into Houzs and see their own orders?** Today: no —
   and a scoped Houzs rep sees nothing in company 2990, which this design **recommends keeping**
   (§3.6). Changing it means creating Houzs users for 2990 staff (the UM merge), not a scope-rule
   tweak. Confirm "nothing" is the intended answer. (Q7)

---

## Appendix — verification trail

| Claim | Verified at |
|---|---|
| Mirror is SO-only, 3 triggers, `entity='sales_order'` | `docs/2990-live-sync/01_outbox_2990.sql`, `02_worker_2990.sql:32`, `backend/src/scm/routes/so-mirror.ts` |
| Import = 33 tables, INSERT-only, no id remap, `staff` forceInactive + no `company_id`, no `user_id` handling | `backend/scripts/migrate-2990-into-houzs.mjs` (ORDER line 12, insert line 41, `NO_CID` line 21) |
| **F1** Houzs `so_amendments` has `header_changes`; 2990 does not | `backend/src/db/migrations-pg/0119_scm_so_amendment_header_changes.sql` vs `2990s/packages/db/migrations/0210_so_amendments.sql` [external] |
| **F2** `applySoAmendment` mutates SO header + items, bumps `revision`; mirror delete-and-reinserts items | `backend/src/scm/lib/so-revision.ts` -> `applySoAmendment()`; `backend/src/scm/routes/so-mirror.ts` -> the `soMirror` router |
| **F3** `companyDocPrefix` → `2990-`; minter `.like()` + max+1 over the mirrored set | `backend/src/scm/lib/companyScope.ts:191-199`; `backend/src/scm/routes/mfg-sales-orders.ts:747-760` |
| **F4** mutations not company-scoped | `backend/src/scm/routes/so-amendments.ts:222-233` (approve-so loads `.eq('id', id)`, no `scopeToCompany`) |
| `staff.user_id` scope mapping | `backend/src/scm/lib/salesScope.ts:49-79` |
| Amendment actor columns FK → `scm.staff(id)`; 2990's FK → `public.staff(id)` | `0080_scm_so_amendment_workflow.sql`; `2990s/.../0210_so_amendments.sql` [external] |
| `company_id` already on all four amendment tables | `0080_scm_so_amendment_workflow.sql:112-119` |
| 2990's 5 amendment gates + `canTransition` guard | `2990s/apps/api/src/routes/so-amendments.ts:134,205,272,370,425` |
| CI auto-applies `migrations-pg` to PROD every deploy | `.github/workflows/deploy.yml:59` |
| `pg-migrate` splits on `;\n` → no `DO` blocks | `0119_...sql` header |
| Sentinel exists, read-only, alarms by failing the job | `.github/workflows/mirror-sentinel.yml` |
| Only trigger in `migrations-pg` is `trg_sync_user_to_staff` (**ASSUMPTION**: prod may carry out-of-band `scm` triggers → P2) | `0066_scm_staff_user_sync.sql:109` |

**Not verified (prod-only state, deliberately not queried from a design task):** the hand-copied
amendment row's actual `so_doc_no` value; whether `scm.mfg_sales_orders.customer_id` carries a
real FK in the pure-DDL port; the live `scm` trigger inventory (P2); integer-id overlap (P3).
Each is a Phase-0 pre-check.

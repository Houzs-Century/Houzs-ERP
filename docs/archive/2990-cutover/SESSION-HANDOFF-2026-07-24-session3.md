> **ARCHIVED 2026-08-13.** Session baton from **2026-07-24**, closed. **Its HARD RULE 1 is now false** — `main` has been protected by the `main-protection` ruleset since **2026-07-31**; see `CLAUDE.md`. Do not follow this file's merge-gate instructions. Kept for history; do not follow it as a current instruction.

# Session-3 handoff — Houzs ERP owner-feedback sprint (2026-07-24)

Written because the owner's monthly usage limit was hit mid-sprint. This is the
authoritative pick-up doc. Working clone used this session:
`C:\Users\User\AppData\Local\Temp\claude\C--Users-User\26e056fc-e962-4250-a086-12cec7c1d323\scratchpad\houzs-audit`
(= `hello-houzs/Houzs-ERP`). Owner = Lim (weisiang329@gmail.com), non-technical,
communicates in Chinese, cannot read code — he tests the live app
(`erp.houzscentury.com`, currently viewing the **2990** company) and reports by
screenshot. Standing authority: **you check CI and merge PRs yourself**; report
outcomes honestly.

## HARD RULES (do not violate)

1. **`main` has NO branch protection — you are the merge gate.** Re-check CI
   green with `gh pr view <n> --json state` / `gh pr checks` IMMEDIATELY before
   merging, and **verify MERGED state after** (never trust a watcher's echo — a
   prior session reported merges that never happened). Use `git -C <repo>` /
   `gh --repo` in background watchers (cwd resets between Bash calls).
2. **DO / In-Transit / delivery-order status logic belongs to the owner's
   PARTNER (a second concurrent Claude session).** Do NOT touch DO status flows,
   In-Transit, trips, or delivery-planning state derivation. Display-only reads
   of that data are fine. The partner also pushes directly to main sometimes
   (e.g. 81bfca41 broke main's tests this session — see #1210).
3. Repo rules (CLAUDE.md): no emoji anywhere; BUG-HISTORY.md entry per bug in
   same PR; `migrations-pg/` is the LIVE tree, take the number at MERGE time;
   **DROP COLUMN must drop dependent VIEWS first** (mig 0189 broke prod, fixed
   by partner's #1203); never accept/echo secrets; every task in its own
   worktree with `npm ci` before typecheck; desktop + mobile change together;
   never ask the owner to run SQL — build a read-only `workflow_dispatch` check.
4. Recurring flaky CI: a frontend vitest teardown throws `window is not defined`
   / "Not implemented: navigation" AFTER all tests pass, reddening the job. It
   is NOT your change — rerun the failed job (`gh run rerun <id> --failed`) and
   it goes green. A standing task chip exists to fix it properly (DataGrid.test
   teardown). Hit #1196, #1207 this session.

## Merged & DEPLOYED this session (all verified in main)

#1182 SO drill: Group + per-line Stock pill + Incoming PO·ETA columns · #1184
supplier Code/Name split into two columns (8 surfaces) · #1185 delivered-DO
backfill (APPLIED: 12 DOs+SOs → DELIVERED, 19/19 verify) · #1186 + #1194 fabric
supplier-code format, FINAL = `CG-001 Pearl (KN390-1)` (parens LAST) · #1187
StatePicker → single combobox (type filters the open list) · #1191 legacy
`processing_date` column retired (one date = `internal_expected_dd`) · #1192 +
#1196 whole UI on the SYSTEM font (plain zero, owner: Plex Mono's dotted 0 read
wrong) · #1195 Combo Pricing shows the SELLING map (was reading the nullable
cost map → all dashes) · #1199 SO status tabs show all 10 statuses summing to
ALL · #1200 every DataTable column sortable + cells clip (no more overlap) ·
#1205 handoff · #1206 SO/DO/SI quick-views show Processing + Delivery dates ·
#1207 colour-KIV lines BLOCK setting a Processing Date · #1208 the 2990-parity
audit doc · #1209 **one line-identity + fabric-supplier-code rule across every
document + inventory + PDF surface** (23 files) · #1210 fixed main after the
partner's direct push broke test fixtures.

Also: 12 stuck 2990 DOs backfilled DISPATCHED→DELIVERED (Sales Report Delivered
now 19). Diagnostics in Actions (all read-only workflow_dispatch): "Amendment
apply check", "2990 delivered-chain check", "Backfill 2990 delivered DOs"
(DRY-RUN gated), plus the price-baseline backfill (APPLY still HELD — dup/RM0
rows in the 2990 reconstruction).

## IN-FLIGHT WORK KILLED BY THE USAGE LIMIT — REDO THESE

Four background agents were running when usage cut out. Their worktrees may
exist under `scratchpad/wt-*`; check `git worktree list` and each branch's push
state before restarting. NONE of these opened a PR except where noted.

1. **Six-list + Delivery-Planning expansions** (branch `feat/list-expansions-everywhere`,
   worktree `wt-list-expansions`). Owner wants the SO-style expandable row drill
   (Group + code/variant + Qty; SO/DO-side also Stock pill + Incoming PO·ETA) on
   the SIX lists that have NONE — **PO, GRN, PI, PR, SI, DR** — AND on the
   **Delivery Planning board** (desktop `DeliveryPlanning.tsx` + `MobileDeliveryPlanning.tsx`).
   Reference impl: `SoLinesExpansion` in `MfgSalesOrdersListV2.tsx`; reuse each
   page's existing detail hook and `useMfgSalesOrderDetail(docNo)` for the board
   (lazy per-row fetch — do NOT widen the board bulk endpoint). Agent had
   pre-staged a shared drill component. STRICT: no DO status logic.

2. **PO/PI/GRN/PR PDF fixes** (branch `fix/supplier-pdf-fabric-warehouse`,
   worktree `wt-po-pdf-fixes`). Owner screenshot of a PO PDF:
   (a) fabric DUPLICATED — `Fabric: KN390-1 (CG-001) CG-001 Pearl (KN390-1)`.
   OWNER RULING: every PDF, supplier-facing included, uses the UNIFIED format
   `CG-001 Pearl (KN390-1)` — stop the "supplier-code-first" recomposition
   (`specsLine` / `loadFabricSupplierMap` in the pdf libs); the supplier's own
   item code stays only in the Item/Supplier-Code column.
   (b) DELIVER TO shows "KL WAREHOUSE · BALAKONG WAREHOUSE KL" → show ONLY the
   warehouse CODE ("KL").
   (c) DELETE the "Sofa layout — front faces TV" diagram from the PO PDF (only
   PO; leave customer SO PDFs).

3. **Free Item Campaigns maintenance page** (branch `feat/free-item-campaigns-maintenance`,
   worktree `wt-campaigns-maint`). Backend CRUD already exists
   (`backend/src/scm/routes/free-item-campaigns.ts`, table `free_item_campaigns`:
   id, name, active, max_free_qty, eligible). NO UI exists. Add a "Free Item
   Campaigns" tab under Products maintenance (`Products.tsx` tab strip pattern,
   gate like COMBO PRICING): list/create/edit/disable, show usage count if
   cheap. The `FREE · <campaign>` line subtitle already renders via
   `variants.freeItem.campaignId` → confirm it shows the NAME and whether it is
   live or snapshotted.

4. **Inventory numbers investigation — COMPLETE (findings below), fixes NOT
   built.** No PR. Build the fixes.

## Inventory findings (investigation done — build the fixes)

Root cause of nearly every "wrong number": TWO on-hand bases that legitimately
diverge on oversell — **QTY/Stock/Available** = signed SUM of `inventory_movements`
(unfloored, can be negative); **Value/Unit-Cost** = SUM(qty_remaining × cost)
over open FIFO lots (always ≥0). Documented in
`0154_scm_oversell_retrocost.sql:8-19`; they re-converge only when the matching
GRN posts (`fn_reconcile_uncosted_out`). Symptom map:
- Qty 0 / Value RM1,039 / Avg "—": phantom per-`variant_key` bucket — DATA
  artifact shown honestly but confusingly (`inventory.ts:526-566`,
  `Inventory.tsx:965-991`). AVG "—" is correct-by-design (won't divide by 0).
- XAMMAR-2A(LHF) Stock 1 / Unit Cost RM4,106 = open-lot value (qty_remaining 2)
  ÷ movement-net qty (1). DERIVED display artifact, not a real unit cost.
- Available = Stock − `reserved_total` (ALL open non-done SO demand), NOT
  Stock − reserve7/14 (those are near-window subsets driven by
  `line_delivery_date ?? customer_delivery_date` vs MY-today+7/14). Negative =
  overcommitted. Numbers are internally consistent (no double-count — delivered
  units net out of the reservation).
- Age = days since oldest OPEN lot's `received_at` (not last movement) — can
  disagree with Stock under oversell (same divergence).
- LOCATION dual name: `Inventory.tsx:972` renders `code · name`; that warehouse
  row's `code` is a long string. Canonical single display = `warehouse_name`
  (or code alone). Owner wants ONE name, PDFs want the CODE.

OWNER'S EXPLICIT ASKS from this (build these):
- **Show the "Committed/需求" column** so Available is a visible equation:
  `Stock + Incoming − Committed = Available`. Owner: cannot trust a black-box
  Available without seeing the demand that produced it.
- **Adjustment reason visible in Movements**: `inventory_movements.reason_code`
  + `notes` EXIST and are written (`inventory-adjustments.ts`), the UI only
  renders `notes`. Add a Reason column via `adjustmentReasonLabel(reason_code)`
  in `Inventory.tsx` MovementsTab (~1197-1259), SKU-expansion (~1080), and
  `StockCard.tsx` (~248). Pure display fix.
- **Reserved-but-unshipped visibility**: owner points at a lot "16 days not
  shipped" and wants to know allocated-to-SO vs no-order. Cheapest correct
  design (NO schema change): read-only `GET /inventory/reservations` joining
  `v_inventory_lots_open` ↔ `mfg_sales_order_items`(stock_status='READY',
  allocated_batch_no for sofa) ↔ `mfg_sales_orders` (doc_no, created_at). No
  allocation timestamp exists → use SO `created_at` as the honest "reserved
  since" proxy, or add one `allocated_at` column + one write in
  `so-stock-allocation.ts` (~289-301) for a true age.
- **UI cleanups**: Stock Breakdown drawer layout is broken, Notes cell
  overflows, header font size — tidy all three; single warehouse name.

## 2990 parity result (doc merged as #1208)

Allocation/MRP/sofa-batch/negative-stock/costing/inventory ALL match 2990. One
real GAP: the ordinary convert-from-SO path lost 2990's hard remaining-qty 409
(now UI-protected only) — cheap to restore, **owner asked, awaiting his
go-ahead** before building. Confirmed for the owner: allocation is
delivery-date-first for ALL categories (mattress not special); costing = SO
snapshot / DO actual-FIFO / PI final; inventory in/out identical.

## Owner queue (his stated order — SO/PO Amendment LAST)

Pending owner decisions: (a) restore convert-from-SO qty cap? (b) DO-open =
DELIVERED policy (skip DISPATCHED)? his call. (c) SERVICE line Stock cell — he
OK'd the dash. Build queue after the killed-agent work: Sales Director POS perms
= exact 2990 POS parity (only that role) · Org Chart grouped by company · Sales
Venue save bug · one-off global `recomputeSoStockAllocation` sweep for migrated
2990 SOs (so their Stock/Incoming light up) · MRP coverage snapshot-to-DB (write
allocated PO+ETA at allocation time; read-time compute is temporary) · THEN the
approved **SO/PO Amendment redesign** (two-step SO Requested→Approved with
supplier-confirm as optional evidence; PO dual-track: office direct Edit pre-GR +
PO Amendment with approval; auto PO revision after SO approve; mockup artifact
exists). The amendment mystery is solved: SO-2607-015/A1 was never approved
(approve button was hidden behind the supplier-confirm step — now fixed by the
two-step design intent + #1207 gate context).

## First moves for the next session

1. `git worktree list`; for each `wt-list-expansions / wt-po-pdf-fixes /
   wt-campaigns-maint`, check if the branch has commits/pushed — resume or
   restart the four killed items above.
2. Then the inventory fixes (Committed column + equation, Reason column,
   reservations endpoint, drawer/header/warehouse-name cleanup).
3. Re-verify prod after each deploy via Chrome (owner must hard-refresh
   Ctrl+Shift+R — PWA caches). Confirm on the LIVE Sales Orders / Inventory
   pages, screenshots to the owner.

> **ARCHIVED 2026-08-13.** Its "PLAN ONLY, nothing implemented" banner is no longer true: the Draft/Confirmed lifecycle shipped for DO, SI, PO, GRN and PI (`backend/src/scm/routes/`). Per-module behaviour now lives in `docs/modules/`. Kept for history; do not follow it as a current instruction.

# Draft / Confirmed two-state model for five SCM documents

Plan to give **DO, SI, PO, GRN, PI** the same Draft → Confirmed lifecycle the
**Sales Order (SO)** already has: a doc lands as `DRAFT` (no committed side
effects), the operator reviews it, then a **Confirm** action flips it to the
live committed state. Lists gain Draft / Confirmed tabs; details gain a DRAFT
banner + Confirm button.

> Status: PLAN ONLY. Nothing in this doc is implemented. Read-only survey of
> `backend/src/scm/routes/*` and `frontend/src/pages/scm-v2/*` on 2026-06-24.

Tags used below: **NET-NEW** = code/migration that does not exist yet;
**WIRE-EXISTING** = a hook / filter / handler already present that we extend or
re-point.

---

## 0. The SO template (what we are copying)

### 0.1 Status model
- Enum: `scm.mfg_so_status` — dump (`scripts/scm-schema/2990s-full-schema.sql:16`)
  is `('CONFIRMED','IN_PRODUCTION',…,'CANCELLED')` with **no `DRAFT`**. Default
  `'CONFIRMED'` (`:676`).
- Yet the SO route **writes `'DRAFT'`** (`mfg-sales-orders.ts:3072`:
  `status: body.asDraft === true ? 'DRAFT' : 'CONFIRMED'`) and reads it in
  guards. **There is NO in-repo `ALTER TYPE … ADD VALUE 'DRAFT'` migration.**
  So the live `scm.mfg_so_status` must already carry `DRAFT` out-of-band
  (inherited from the pre-0078 2990 enum). **This is the #1 thing to verify
  before building** (see §7 risk R1) — it tells us exactly what the enum-add
  migration must look like for the other five.

### 0.2 Create-as-DRAFT path
`POST /mfg-sales-orders` — `status: asDraft ? 'DRAFT' : 'CONFIRMED'`
(`:3072`). DRAFT is opt-in per request; a manual SO defaults to CONFIRMED, a
scanned/auto SO can be saved as DRAFT.

### 0.3 Confirm action
There is **no dedicated confirm endpoint** — confirm reuses the generic status
PATCH `PATCH /mfg-sales-orders/:docNo/status` (handler at `:3446`), called with
`status:'CONFIRMED'`. The frontend hook is **`useUpdateMfgSalesOrderStatus()`**
(`MfgSalesOrdersList.tsx:747`, `SalesOrderDetail.tsx`). The status PATCH writes
`mfg_so_status_changes` + `recordSoAudit` and recomputes stock allocation.

### 0.4 Leak guards (≈11) that keep a DRAFT SO out of committed flows
Pattern: every committed read filters `status != 'DRAFT'`. Concretely in
`mfg-sales-orders.ts`:
- Dashboard summary excludes DRAFT — `.neq('status','DRAFT')` (`:576`).
- Stock-allocation / READY pool — `.not('status','in','("CANCELLED","ON_HOLD","DRAFT")')` (`:913`).
- Duplicate-phone / dedupe scans — `.not('status','in','("CANCELLED","DRAFT")')` (`:1156`, `:1200`, `:3822`).
- Cancel→credit guard skips DRAFT — `fromStatus !== 'DRAFT'` (`:3488`).
- Plus MRP / PO-from-SO / DO-from-SO pickers + KPI tiles read CONFIRMED-only
  pools. The unifying rule: **DRAFT is invisible to MRP, PO, DO, credit, KPI.**

### 0.5 Frontend tabs + detail confirm (the visual template)
- **List tabs:** the SO list (`MfgSalesOrdersList.tsx`) is the odd one out — it
  uses the shared **DataGrid** with status as a filterable/groupable column +
  4 KPI tiles (`:702`, `:924`), NOT a hardcoded `STATUS_CHIPS` pill bar. The
  "Draft (0) / Confirmed (0)" tabs the brief refers to are the grid's status
  filter. **The other five lists DO use a literal `STATUS_CHIPS` array** — that
  is the cleaner thing to extend for them (add `'DRAFT'`).
- **Detail DRAFT banner + Confirm button:** the gold copy to mirror is
  `SalesOrderDetail.tsx:971-1007` — an orange banner ("Draft — not yet
  confirmed… stays out of MRP / PO / DO until then") + a primary
  **"Confirm Order"** button that runs `askConfirm()` then
  `updateStatus.mutate({ status:'CONFIRMED' })`. Copy this block per doc.

### 0.6 The shared status→label map
`frontend/src/vendor/scm/lib/status-pill.ts` is the ONE source of truth for
every list/detail StatusPill (per-docType `Record<status,{label,tone}>`). It has
no `DRAFT` row for ANY docType today (not even SO). Every doc below needs a
`DRAFT: { label: 'Draft', tone: 'pending' }` entry added here. **WIRE-EXISTING.**

---

## Shared / common work (do once, reused by all five)

1. **Per-enum DRAFT migration — NET-NEW, one file PER doc** (5 files).
   Each adds `DRAFT` to that doc's status enum. **Migration-runner gotcha
   (`scripts/pg-migrate.mjs:60-78`): the runner wraps each file in ONE
   transaction.** Postgres forbids using a freshly-added enum value later in the
   same transaction, and older PG forbids `ALTER TYPE … ADD VALUE` inside a txn
   at all. Therefore each enum-add must be **its own file containing ONLY the
   ALTER** (no insert/use of DRAFT in the same file), and must set
   `SET search_path = scm, public;` so the enum resolves to `scm.*` (precedent:
   `0037_scm_payment_three_methods.sql:28`). Use the postgres `ADD VALUE IF NOT
   EXISTS 'DRAFT' BEFORE '<current-default>'` form for idempotency (runner
   requires idempotent migrations). Suggested order: keep DRAFT first so it
   reads naturally, e.g. `… ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'LOADED'`.
   - DO: `ALTER TYPE scm.do_status ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'LOADED';`
   - SI: `… scm.sales_invoice_status … BEFORE 'SENT';`
   - PO: `… scm.po_status … BEFORE 'SUBMITTED';`
   - GRN: `… scm.grn_status … BEFORE 'POSTED';`
   - PI: `… scm.purchase_invoice_status … BEFORE 'POSTED';`
   Per repo rule **migrate-before-deploy**: apply these via SQL editor BEFORE
   pushing code that writes/reads `'DRAFT'`, or the live API 500s.

2. **Shared status-pill labels — WIRE-EXISTING.** Add
   `DRAFT: { label: 'Draft', tone: 'pending' }` to the `DO/SI/PO/GRN/PI` maps in
   `frontend/src/vendor/scm/lib/status-pill.ts` (and SO too, for consistency).

3. **A reusable confirm pattern — WIRE-EXISTING + light NET-NEW.** Each doc
   already has either a status PATCH or a no-op `/post` endpoint we can convert
   into the confirm transition (details per doc). On the frontend, each doc
   already has a status/cancel mutation hook in its `*-queries` module; add a
   thin `useConfirm<Doc>()` that PATCHes the confirm endpoint and invalidates the
   list + detail queries (mirror `useUpdateMfgSalesOrderStatus`).

4. **TypeScript status unions.** Wherever a doc's status is a literal union in
   the frontend (e.g. `PoStatus`), add `'DRAFT'`. **WIRE-EXISTING.**

5. **No new audit tables.** None of the six docs has a status-changes table
   except SO (`mfg_so_status_changes`). Match the existing convention: stamp a
   timestamp column on confirm (`posted_at` / `submitted_at` already exist on
   GRN/PO; reuse, set on confirm instead of on create). Do NOT add per-doc audit
   tables — out of scope.

---

## DO — Delivery Order

Files: `backend/src/scm/routes/delivery-orders-mfg.ts` ·
`frontend/.../MfgDeliveryOrdersList.tsx` · `.../DeliveryOrderDetail.tsx` ·
`.../DeliveryOrderFromSo.tsx`

**Current status model:** `scm.do_status =
('LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED')`,
default `'LOADED'`. **No draft-like state** — a DO is created straight at
`'DISPATCHED'` (`:1486`, and `/from-sos` `:1747`) because "a DO means goods are
OUT the moment it's created". `SHIPPED_STATES` (`:89`) =
`['DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED']` gates stock moves.

**What to add:**
- **Migration:** `DRAFT` → `do_status` (shared §1). **NET-NEW.**
- **Create-as-draft:** in `POST /` (`:1363`) and `POST /from-sos` (`:1570`),
  when `asDraft`, set `status:'DRAFT'` and **skip `deductInventoryForDo`**
  (`:1503`, `:1815`). **WIRE-EXISTING** (gate the existing call).
- **Confirm action:** extend `PATCH /:id/status` (`:2256`) to accept
  `DRAFT → DISPATCHED`; the handler already calls `deductInventoryForDo` when
  the target is in `SHIPPED_STATES` (`:2326`) and that fn is idempotent on
  prior OUT rows. So confirm = move to DISPATCHED, stock deducts there.
  **WIRE-EXISTING.**
- **List tabs:** `MfgDeliveryOrdersList.tsx` — add `'DRAFT'` to `STATUS_CHIPS`
  (`:127`); **fix `doEffectiveKey` (`:121`) which currently maps anything
  non-cancelled/returned/invoiced to `'DISPATCHED'`** — it must return `'DRAFT'`
  when `status==='DRAFT'` (else a draft renders as "Shipped"). Add a `DRAFT`
  entry to `STATUS_CLASS` (`:96`). **WIRE-EXISTING (one real bug to fix).**
- **Detail banner + Confirm:** `DeliveryOrderDetail.tsx` — same fix to
  `doEffectiveKey` for the badge (`:539`); add the DRAFT banner + "Confirm &
  Ship DO" button above the status pill (`:551`), copying SO `:971-1007`.
  **NET-NEW (per-doc copy).**

**Leak guards DO needs (riskiest first):**
- **Stock (CRITICAL):** DRAFT DO must NOT call `deductInventoryForDo`. Single
  callsite per create path (`:1503`, `:1815`) + the `SHIPPED_STATES` gate in
  PATCH — make sure `'DRAFT'` is NEVER added to `SHIPPED_STATES`.
- **KPI:** list KPIs are computed client-side over visible rows
  (`MfgDeliveryOrdersList.tsx:369`) — exclude DRAFT from revenue/qty tiles, or
  let the Draft tab simply not contribute to the "all" KPI.
- **SI feed:** SI's "outstanding DO" picker must hide DRAFT DOs (see SI guard).
- **Lifecycle badge:** `computeDoLifecycle` (`:1088`) is "latest event wins" —
  ensure DRAFT short-circuits before lifecycle override.

**Cross-doc coupling:** DO is created from a CONFIRMED SO (`DeliveryOrderFromSo`)
— unchanged. SI reads DO lines (`sales_invoice_items.do_item_id`); guarded on
the SI side. A DRAFT DO has not moved stock, so it must not be SI-able.

---

## SI — Sales Invoice

Files: `backend/src/scm/routes/sales-invoices.ts` ·
`frontend/.../SalesInvoicesList.tsx` · `.../SalesInvoiceDetail.tsx` ·
`.../SalesInvoiceFromDo.tsx`

**Current status model:** `scm.sales_invoice_status =
('SENT','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED')`, default `'SENT'`. **No
draft.** `POST /` (`:212`) and `POST /from-dos` (`:328`) both create at `'SENT'`
and immediately stamp `sent_at`/`confirmed_at`.

**What to add:**
- **Migration:** `DRAFT` → `sales_invoice_status` (shared §1). **NET-NEW.**
- **Create-as-draft:** in both create paths, when `asDraft`, set `status:'DRAFT'`,
  leave `sent_at`/`confirmed_at` NULL, and **skip the AR/credit/paid calls**
  (below). **WIRE-EXISTING** (gate existing calls).
- **Confirm action:** the existing `PATCH /:id/status` (`:856`) handles
  CANCELLED + REOPEN only. Extend it (or add `PATCH /:id/confirm`) for
  `DRAFT → SENT`, and **move the AR/credit/paid posting into the confirm
  transition** rather than create. **WIRE-EXISTING + small NET-NEW.**
- **List tabs:** `SalesInvoicesList.tsx:106` — add `'DRAFT'` to `STATUS_CHIPS`.
  Backend list `?status=` already passes through (`:180`). **WIRE-EXISTING.**
- **Detail banner + Confirm:** `SalesInvoiceDetail.tsx` — `<StatusPill>` (`:437`)
  picks up DRAFT from the shared map; add Confirm button + DRAFT banner near the
  Cancel/Reopen block (`:446`); add DRAFT to `lockedStatuses` (`:195`) so header
  stays editable while draft. **NET-NEW (per-doc copy).**

**Leak guards SI needs (riskiest first):**
- **AR / GL posting (CRITICAL):** DRAFT SI must NOT call **`postSiRevenue()`**
  (`:289`, `:478`; def `post-si-revenue.ts:44`) — that writes Dr 1100 AR / Cr
  4000 Sales. Gate it to the confirm transition.
- **Customer credit (CRITICAL):** DRAFT SI must NOT call
  **`applyCustomerCreditToSi()`** (`:300`, `:490`; def `customer-credits.ts:80`)
  — auto-applies credit + advances `paid_centi`.
- **Paid rollup:** DRAFT SI must NOT `recomputePaid()` (`:323`, `:778`) and must
  **reject payments** — gate `POST/PATCH/DELETE /:id/payments*` (`:746`+,
  payable check `:804`) on `status!=='DRAFT'`.
- **Line mutations:** `POST/PATCH/DELETE /:id/items` call
  `postSiRevenue/resyncSiRevenue` (`:568`) — for a DRAFT SI, edit lines WITHOUT
  re-posting GL.
- **Outstanding / AR-aging:** the `v_si_outstanding` view (`outstanding.ts:46`)
  and the list outstanding KPI (`SalesInvoicesList.tsx:332`) must exclude DRAFT
  (today they exclude only CANCELLED).

**Cross-doc coupling (IMPORTANT):** SI is created **from a DO**
(`/from-dos`). Today there's no DO-status gate beyond "DO not CANCELLED"
(`:406`). **Decision needed:** require the source DO to be CONFIRMED (non-DRAFT)
before an SI can draw from it — a DRAFT SI off a DRAFT DO would represent
un-shipped goods. Also: posting an SI does **not** currently flip the DO to
INVOICED (no such callsite) — so no DO-flip guard needed, but if one is added
later it must be gated to the SI confirm transition, not create.

---

## PO — Purchase Order

Files: `backend/src/scm/routes/mfg-purchase-orders.ts` ·
`frontend/.../PurchaseOrders.tsx` · `.../PurchaseOrderDetail.tsx` ·
`.../PurchaseOrderFromSo.tsx`

**Current status model:** `scm.po_status =
('SUBMITTED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')`, default
`'SUBMITTED'`. **DRAFT was explicitly removed by migration 0078** (comment
`:613`: "PO 是直接 create 的，不需要进入 DRAFT"). `POST /` (`:503`) creates
`'SUBMITTED'` + `submitted_at` (`:620`). `PARTIALLY_RECEIVED`/`RECEIVED` are
auto-advanced from GRN receipts via `recomputePoReceived()` (`grns.ts:272-291`).

**What to add:**
- **Migration:** `DRAFT` → `po_status` (shared §1). **NET-NEW.**
- **Create-as-draft:** `POST /` — when `asDraft`, set `status:'DRAFT'`, leave
  `submitted_at` NULL, and **do NOT call `recomputeSoPicked`** (`:670`) (which
  advances the SO line's `po_qty_picked` and removes it from the From-SO
  picker). **WIRE-EXISTING** (gate existing call).
- **Confirm action:** **NET-NEW** `PATCH /:id/confirm` (DRAFT → SUBMITTED) — sets
  `status='SUBMITTED'`, stamps `submitted_at`, and **runs `recomputeSoPicked`
  here** (moved out of create).
- **List tabs:** `PurchaseOrders.tsx` uses a `StatusFilter` of
  `'all' | 'outstanding'` (`:45`) rather than per-status chips. Add a `'draft'`
  tab; extend the client filter (`:234`) and `STATUS_COLOR` (`:54`).
  **WIRE-EXISTING.**
- **Detail banner + Confirm:** `PurchaseOrderDetail.tsx` — `<StatusPill docType="po">`
  (`:583`) picks up DRAFT; add DRAFT banner + Confirm button before the Cancel
  block (`:605`); allow Edit while DRAFT. **NET-NEW (per-doc copy).**

**Leak guards PO needs (riskiest first):**
- **MRP supply (CRITICAL):** a PO counts as incoming supply in MRP. `mrp.ts`
  `PO_DEAD = new Set(['CANCELLED'])` (`:55`) — **add `'DRAFT'`** so a draft PO
  doesn't make an SO line look "covered". This pool also drives the From-SO
  shortage cap (`mfg-purchase-orders.ts:266`, `computeMrp`).
- **GRN-ability:** the GRN-from-PO picker filters
  `po.status === 'SUBMITTED' || 'PARTIALLY_RECEIVED'` (`grns.ts:483`) — once the
  enum has DRAFT, DRAFT is naturally excluded (it's neither). Verify the batch
  GRN-create route inherits that gate.
- **SO quota:** DRAFT PO must NOT advance `recomputeSoPicked` (moved to confirm,
  above).

**Cross-doc coupling:** PO is created from a CONFIRMED SO via MRP
(`PurchaseOrderFromSo`). GRN reads PO rows; the picker gate (`grns.ts:483`)
keeps DRAFT POs un-GRN-able.

---

## GRN — Goods Received Note

Files: `backend/src/scm/routes/grns.ts` · `frontend/.../GoodsReceived.tsx` ·
`.../GoodsReceivedDetail.tsx` · `.../GrnFromPo.tsx`

**Current status model:** `scm.grn_status = ('POSTED','CLOSED','CANCELLED')`,
default `'POSTED'`. **No pre-post state** — a GRN is created straight at
`'POSTED'` (`:778`) and `postGrnAndRollup()` (`:52`) fires immediately on create
(`:836`), which (a) writes inventory IN via `writeMovements` (`:88-106`) and
(b) advances the source PO via `recomputePoReceived()` (`:63`).

**What to add:**
- **Migration:** `DRAFT` → `grn_status` (shared §1). **NET-NEW.**
- **Create-as-draft:** `POST /` — when `asDraft`, set `status:'DRAFT'` (`:778`)
  and **do NOT call `postGrnAndRollup()`** (`:836`). **WIRE-EXISTING** (gate the
  existing call).
- **Confirm action:** **NET-NEW** `PATCH /:id/confirm` (DRAFT → POSTED) that
  calls `postGrnAndRollup()` (the existing fn already does stock IN + PO rollup
  atomically and is idempotent). So the entire commit moves from create → confirm.
- **List tabs:** `GoodsReceived.tsx:39` — add `'DRAFT'` to `STATUS_CHIPS`
  (`['all','POSTED','CLOSED','CANCELLED']`); client filter (`:274`) picks it up.
  **WIRE-EXISTING.**
- **Detail banner + Confirm:** `GoodsReceivedDetail.tsx` — update `isLocked`
  (`:239`, currently `status!=='POSTED' || hasChildren`) so DRAFT is editable;
  add DRAFT banner + "Confirm & Receive" button. `<StatusPill docType="grn">`
  (`:402`) picks up DRAFT. **NET-NEW (per-doc copy).**

**Leak guards GRN needs (riskiest first):**
- **Stock (CRITICAL):** DRAFT GRN must NOT `writeMovements` IN — single chokepoint
  is `postGrnAndRollup()` (`:52`); gate the whole call to confirm.
- **PO advance (CRITICAL):** DRAFT GRN must NOT `recomputePoReceived()` (`:63`)
  — gated by the same `postGrnAndRollup` skip.
- **PI feed:** PI's outstanding-GRN picker already filters
  `eq('status','POSTED')` (`purchase-invoices.ts:201`) → DRAFT GRN is naturally
  PI-invisible. Verify no other PI path reads non-POSTED GRNs.
- **Cancel reversal:** the cancel handler (`:1220`) writes inventory OUT
  (`:1286-1319`) + recounts PO — for a DRAFT GRN, cancel must skip both (nothing
  to reverse). Add a `status==='DRAFT'` short-circuit.

**Cross-doc coupling:** GRN is created from a SUBMITTED PO (`GrnFromPo`). GRN
feeds PI via `grn_item_id`; the `POSTED`-only picker keeps DRAFT GRNs out.

---

## PI — Purchase Invoice

Files: `backend/src/scm/routes/purchase-invoices.ts` (+ `./accounting`) ·
`frontend/.../PurchaseInvoices.tsx` · `.../PurchaseInvoiceDetail.tsx` ·
`.../PurchaseInvoiceFromGrn.tsx`

**Current status model:** `scm.purchase_invoice_status =
('POSTED','PARTIALLY_PAID','PAID','CANCELLED')`, default `'POSTED'`. **DRAFT was
removed by 0078** — the route has an explicit reject:
`if (body.status === 'DRAFT') return 400 'draft_status_not_supported'` (`:320`).
`POST /` (`:317`) and `/from-grn(-items)` create at `'POSTED'` (`:401`).

**What to add:**
- **Migration:** `DRAFT` → `purchase_invoice_status` (shared §1). **NET-NEW.**
- **Create-as-draft:** `POST /` — **remove the DRAFT reject (`:320`)**; when
  `asDraft`, set `status:'DRAFT'`, leave `posted_at` NULL, and **skip the GRN
  consume + GL post** (below). **WIRE-EXISTING.**
- **Confirm action:** the no-op back-compat **`PATCH /:id/post`** (`:433`)
  becomes the real DRAFT → POSTED transition: guard `from===DRAFT`, call
  `recomputeGrnInvoiced()` + `postPiAccounting()`, stamp `posted_at`.
  **WIRE-EXISTING (re-point the stub).**
- **List tabs:** `PurchaseInvoices.tsx:34` — add `'DRAFT'` to `STATUS_CHIPS`;
  filter uses `?status=` already. **WIRE-EXISTING.**
- **Detail banner + Confirm:** `PurchaseInvoiceDetail.tsx` — add DRAFT to
  `isLocked` (`:212`) so it's editable while draft; add Confirm button + DRAFT
  banner near Edit (`:533`). `<StatusPill docType="pi">` (`:504`) picks up DRAFT.
  **NET-NEW (per-doc copy).**

**Leak guards PI needs (riskiest first):**
- **AP / GL posting (CRITICAL):** DRAFT PI must NOT call **`postPiAccounting()`**
  (`accounting.ts:234`, writes Dr Inventory 1200 / Cr Payables 2000). Gate to
  confirm.
- **GRN consume:** DRAFT PI must NOT call **`recomputeGrnInvoiced()`** (`:425`,
  `:734`, `:859`) — that bumps `grn_items.invoiced_qty` and would mark GRN lines
  as billed by a non-real invoice. Gate all three callsites to confirm /
  POSTED-only.
- **Payments / paid rollup:** DRAFT PI must reject payments — the payment PATCH
  (`:450`, payable check `:469`) only blocks CANCELLED today; add a DRAFT block.
- **Outstanding / AP-aging:** the `v_ap_aging` view (`accounting.ts:532`) and
  any PI list/outstanding aggregate must exclude DRAFT.

**Cross-doc coupling (IMPORTANT):** PI is created **from a POSTED GRN** — both
create paths already hard-require it (`grn_not_posted` 409 at `:609`, `:766`).
So a DRAFT PI off a POSTED GRN is fine and the "GRN confirmed first" rule is
**already enforced** — no new gate needed. Posting a PI does NOT flip the GRN
header status (only line `invoiced_qty`), so no GRN-flip guard is required.

---

## Recommended build order

1. **Verify R1 first** (does live `scm.mfg_so_status` actually contain DRAFT?).
   This determines the exact enum-add migration shape and proves DRAFT SOs even
   work today. (§7.)
2. **Shared first:** the 5 enum migrations (one file each, ALTER-only,
   `search_path=scm`), the `status-pill.ts` DRAFT labels, and TS status unions.
   Apply migrations to the live DB BEFORE deploying any code that writes
   `'DRAFT'` (migrate-before-deploy).
3. **GRN, then PO, then DO** (the stock/MRP-moving docs — highest blast radius;
   their commit is a single chokepoint fn: `postGrnAndRollup` /
   `recomputeSoPicked`+MRP-pool / `deductInventoryForDo`). Do GRN first: it has
   the cleanest single-fn commit and de-risks the inventory pattern.
4. **PI, then SI** (the financial docs — gate `postPiAccounting` /
   `postSiRevenue`+credit; SI last because it also needs the source-DO-confirmed
   decision and touches customer credit).
5. For each doc: migration → backend create-as-draft skip → confirm endpoint →
   leak-guard filters → frontend tab → frontend banner+button → manual browser
   test (create draft, confirm, verify NO stock/AR/MRP side effect until
   confirm). Per repo rule, open each SCM page in a real browser — API tests
   miss render-time provider crashes.

---

## 7. Risks / open decisions

- **R1 (blocking): the SO DRAFT enum value is not added by any in-repo
  migration.** The SO route writes `'DRAFT'` but the enum dump lacks it and no
  `ALTER TYPE` migration exists. Either the live enum already has DRAFT
  (out-of-band) or SO DRAFT saves currently 500. Confirm against live
  `information_schema` / `pg_enum` for `scm.mfg_so_status` BEFORE building — it
  is the reference for the other five.
- **R2 (riskiest leak guards):** the **stock movers** — `postGrnAndRollup`
  (GRN), `deductInventoryForDo` (DO) — and the **GL posters** —
  `postPiAccounting` (PI), `postSiRevenue` + `applyCustomerCreditToSi` (SI), and
  the **MRP `PO_DEAD` set** (PO). A missed gate here means a draft silently moves
  stock, books a journal entry, applies customer credit, or fakes supply.
- **R3 (DO frontend bug):** `doEffectiveKey` collapses any non-terminal status
  to `'DISPATCHED'`; without the fix a DRAFT DO renders as "Shipped" on both list
  and detail. Must special-case DRAFT.
- **R4 (cross-doc):** decide whether a DRAFT SI requires its source DO CONFIRMED
  (recommended yes). PI↔GRN is already enforced (POSTED-only); PO↔GRN is enforced
  by the picker; DO↔SO is unchanged.
- **R5 (default behaviour):** like SO, default each new doc to its CONFIRMED
  state and make DRAFT opt-in (`asDraft`), so existing create flows are
  unaffected. Confirm this matches the commander's intent (the 0078 history shows
  he previously asked to REMOVE drafts — re-adding them is a deliberate reversal
  and should be confirmed).

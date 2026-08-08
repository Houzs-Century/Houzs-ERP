# Houzs ERP Go-Live Cutover Plan — AutoCount ⇄ ERP

Status: DRAFT for owner sign-off. Nothing is executed until the three hard
prerequisites (below) are met AND the owner has approved this document.

This is a **one-time production cutover**: wipe the ERP's test/transactional data,
load the real opening snapshot from AutoCount, and go live. After go-live the ERP is
the system of record; changes flow ERP → AutoCount via the write-back service
(already built + live at `https://autocount.houzscentury.com`).

---

## 0. Owner decisions already locked (do not re-litigate)

- **Import ALL outstanding SOs, including old ones.** In this business an SO can sit
  outstanding for a long time and still be legit (waiting on payment / stock / the
  customer). Age is NOT a reason to exclude. No year cutoff.
- **Do NOT wipe masters.** Keep SKU/products, suppliers, agents, venues, users, and
  all lookup tables. Only transactional data is wiped.
- **Import opening stock** (including finished-goods / package stock) — required or
  MRP will re-order everything.
- **Import outstanding POs** — required or the ERP double-buys.
- **Already-proceeded / in-production old orders**: still imported (owner wants all
  outstanding in the ERP), but see §4 note — they carry downstream state, handle with
  care during reconciliation.

---

## 1. Hard prerequisites (NONE of the execution steps run until all three are true)

1. **WRITE PATH into the ERP DB.** The current `claude_ro` role is READ-ONLY by
   design. Wipe + import need write access. Choose one:
   - **A (recommended):** run the migration as a script inside the ERP backend, using
     its own `DATABASE_URL`, behind a `workflow_dispatch` (per the repo's own rule:
     never hand-run prod SQL). Auditable, uses the ERP's data model/validation.
   - **B:** owner provisions a temporary `claude_rw` role; scripts run against it,
     dry-run first. Faster, riskier — drop the role after.
2. **FULL BACKUP taken and confirmed.** Supabase → Database → Backups → take a manual
   snapshot (or confirm the latest automatic PITR point) **before any wipe**. Owner
   must explicitly confirm "backup done". No backup = no wipe. Non-negotiable.
3. **This document signed off** by the owner (wipe scope + mapping rules + sequence).

---

## 2. Wipe scope (transactional only — masters preserved)

WIPE (test/dev transactional data):
- Sales: `mfg_sales_orders`, `mfg_sales_order_items`, `mfg_sales_order_payments`,
  `consignment_sales_orders*`, `sales_orders` (mirror), `sales_order_*` children
- Purchasing: `purchase_orders`, `purchase_order_*`, `purchase_order_docs`
- Fulfilment: Goods Receipts (GR), Delivery Orders (DO), and their line tables
- Inventory movement: stock movements/ledger, allocations/reservations, batches
- Any sync/status scratch tables tied to the above

KEEP (masters + config — never touched):
- `products` / SKU, `supplier_material_bindings`, suppliers, `sales_reps`/agents,
  venues, users/auth, warehouses/locations, categories/series, all lookups
- The AutoCount↔ERP mapping CSV and code

> ACTION before execution: I will produce the **exact table list** (generated from the
> live schema + FK graph) so we wipe children-before-parents and miss nothing / hit
> nothing we shouldn't. Reviewed by owner before it runs.

---

## 3. Opening snapshot to import (source = AutoCount LIVE book AED_HOUZS)

The ERP mirror (`public.sales_orders`, header-only, possibly partial) is NOT the
source. We read the **real AutoCount book** (SO + SODTL lines + PO + stock), because
only it has line items and the authoritative outstanding status.

### 3a. Opening stock
- Source: AutoCount stock balances per Item × Location (incl. finished goods / package
  stock). → ERP stock ledger as opening balances at the cutover timestamp.

### 3b. Outstanding POs
- Source: AutoCount PO headers + lines where remaining/outstanding qty > 0, not
  cancelled. Mirror shows ~273 POs / 431 lines, 224 linked to an SO (`so_doc_no`).
- Map to ERP PO tables; **preserve the SO link** where present.

### 3c. Outstanding SOs (ALL, incl. old)
- Source: AutoCount SO + SODTL where outstanding qty > 0, not cancelled.
- **Verify the authoritative count against AutoCount** (mirror shows ~2422; owner
  believes higher — the mirror is likely incomplete). This count is confirmed at
  execution, first thing.
- For each SO import header + all lines into `mfg_sales_orders` / `_items`, and
  **store the original AutoCount DocNo as a LINK** (`linked_ac_docno`) so later
  edits UPDATE the same AutoCount SO instead of creating a duplicate.
- Customer name + address: AutoCount `DebtorName` + `InvAddr1-4` → ERP customer fields.

---

## 4. Item / variant reverse mapping (AutoCount line → ERP line)

| Category | Difficulty | Rule |
|---|---|---|
| **Mattress** | easy | 1:1 code via the mapping CSV (reversed: ac_code → erp_code) |
| **Accessories** | easy | 1:1 code |
| **Bedframe** | medium | 1:1 code; **parse `Desc2`** (e.g. `NB01 / DIVAN 8" + LEG 4" / GAP 12" / T.Heights 24"`) back into ERP variant fields (fabric/colour, divan, leg, gap, total height) |
| **Sofa** | HARD | AutoCount = **one parent code + compartments in Desc2**; ERP = **multiple compartment lines**. Import must **expand 1 AutoCount line → N ERP compartment lines** (e.g. `HOK-5535 SOFA` + Desc2 `2A+L / fabric / leg` → ERP `5535-2A(LHF)` + `5535-L(RHF)` …), pulling fabric/leg/seat from Desc2. Needs a dedicated parser + **manual spot-check** on a sample before bulk. |

> Bedframe Desc2 is reliably structured (owner confirmed) → parseable.
> Sofa is the one real risk; we validate a sample of sofa expansions by hand before
> trusting the bulk run.

**Un-mappable lines** (code the reverse map can't resolve, or a sofa Desc2 that won't
parse) are NOT silently dropped — they go to an **exceptions report** for manual
resolution. Zero silent data loss.

---

## 5. Execution sequence (only after §1 prerequisites)

1. **Backup** (owner) → confirm.
2. **Dry-run** (read-only): script prints "will DELETE N rows from each table" and
   "will IMPORT: X stock rows, Y POs, Z SOs (with A sofa-expansions, B exceptions)".
   Owner eyeballs the numbers — they must look right — before anything writes.
3. **Wipe** transactional tables (children→parents).
4. **Import opening stock.**
5. **Import outstanding POs** (with SO links).
6. **Import outstanding SOs** (headers + lines + variant mapping + `linked_ac_docno`).
7. **Three-way reconciliation** (§6).
8. **Go live.**

Each step is a separate, re-runnable script; each logs what it did; we stop and review
between steps 3→4→5→6.

---

## 6. Validation — three-way reconciliation (must tie out before go-live)

- **Counts:** ERP outstanding SO count == AutoCount outstanding SO count; same for POs.
- **Money:** ERP outstanding SO value == AutoCount; PO value == AutoCount.
- **Stock:** ERP opening stock per item/location == AutoCount balances.
- **Linkage:** every imported ERP SO has a valid `linked_ac_docno`; every imported PO
  keeps its SO link where AutoCount had one.
- **Exceptions report empty** (or every item on it consciously resolved).

If any of these don't tie out → do NOT go live; investigate.

---

## 7. Rollback

- Any failure before go-live → restore from the §1 backup, full stop, regroup.
- Because masters are untouched and the import is additive after a clean wipe, a
  restore returns to the exact pre-cutover state.

---

## 8. After go-live (the ongoing loop — mostly already built)

- **New orders:** created in ERP → **CREATE** in AutoCount (write-back service, LIVE).
- **Imported old orders:** proceeded / edited in ERP (change/add SKU, customer
  name/address) → **UPDATE** the linked AutoCount SO via `linked_ac_docno`
  (strategy B: never touch AutoCount payment/balance). Requires adding `/update-so`
  to `AcSoService` — small extension of the existing service.
- Distinction that prevents duplicates: has `linked_ac_docno` → UPDATE; else → CREATE.

---

## 9. Open items still needing an owner call

1. **Write path**: A (ERP backend) or B (temp `claude_rw`)?
2. **Backup**: confirm taken before we touch anything.
3. **Exact wipe table list**: I generate it → you approve it.
4. **Sofa expansion sample**: you eyeball a handful of expanded sofas before bulk.

Everything else is decided. On owner sign-off of this doc + the three prerequisites,
execution begins at §5.

---

## 10. IMPORT BUILT — outstanding SO (2026-08-09)

The SO-outstanding import is built as a sanctioned backend script + workflow (NOT
hand-run SQL): `backend/scripts/import-ac-outstanding-so.mjs` +
`.github/workflows/import-ac-outstanding-so.yml` (workflow_dispatch, DRY-RUN by
default, `apply=1` to write, `limit=N` for a small verification run first). Source
data = `backend/scripts/data/ac-outstanding-so.json.gz` (the LIVE AED_HOUZS
outstanding export, 13,333 lines / 2,709 orders).

Owner decisions locked this round:
- **Company 1 only. SOFA EXCLUDED — and a MIXED order (any sofa line) is skipped
  WHOLE**, not partially. Import = the **2,275 pure-non-sofa** orders; 191 mixed +
  243 all-sofa (434 orders / 569 sofa lines) held for a later round.
- **doc_no REUSES the AutoCount number with an `HC-` prefix** (`SO-000021` ->
  `HC-SO-000021`); the raw AutoCount number is stored in **`linked_ac_docno`**
  (migration `0269`) for write-back. `HC-` never collides with the app's bare
  `SO-YYMM-NNN` minter.
- Item codes via the binding CSV (proper CSV parse); **free-text lines resolved by
  name+size against the live `mfg_products` pick list**; delivery -> company-1's
  `TRANSPORTATION CHARGES` (not the 2990 `SVC-DELIVERY`). Bedframe `Desc2` ->
  `gap_inches`/`divan_height_inches`/`leg_height_inches`/colour + specials
  (fully-cover / push-back / HB style) into `custom_specials`.
- **Payment + balance reconcile:** total = Σ(qty·unitprice); `balance_centi` =
  UDF_BALANCE; `paid_centi` = total − balance; a `mfg_sales_order_payments` row is
  written for the paid amount with account_sheet+approval_code parsed from
  UDF_PAYEMENT, `paid_at = CURRENT_DATE` (payment date unknown in the SO export).
- Dry-run (live) result: 2,275 orders, RM 16,178,290 total / RM 8,169,873 balance,
  0 codes outside the pick list, **only 4 exception lines** (truly-blank AutoCount
  lines with a price but no item name, RM 750 total — imported as `(UNMATCHED)` with
  a remark for manual SKU assignment).

Run order: `target=prod, apply=1, limit=5` first -> eyeball 5 in the ERP -> then
`limit=0` for the full set.

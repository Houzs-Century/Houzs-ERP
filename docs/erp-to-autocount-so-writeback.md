# ERP → AutoCount: Sales Order write-back (complete spec)

Goal: when a salesperson creates a Sales Order in the ERP, push it into AutoCount
(HOUZS CENTURY [LIVE]) as an AutoCount Sales Order, with **no manual master setup**
— new SKUs / agents / branding / venue that don't exist in AutoCount yet are
auto-created as part of the push, so "adding new things" never breaks the API.

Target company: Houzs Century (`company_id = 1`). 2990 out of scope.

---

## 0. Current state (2026-08-07)

- The middleware (`it-houzs.dev`, .NET, uses the **AutoCount SDK**, connects to the
  LIVE book — remote `10.147.17.100` over ZeroTier) today exposes only **reads**
  (`getSince/getAll/getSingle/getDetail`, `Creditor/getAll`, `StockItem/getSingle`,
  …) plus two narrow writes (`SalesOrder/updateFromSheet` = 3 fields,
  `PurchaseOrder/update-udf-dates`). There is **no create-SO endpoint**.
- ERP-side kill switch `AUTOCOUNT_WRITES_DISABLED = true` in
  `backend/src/services/autocount.ts` — flip when the create path is ready.
- The AutoCount SDK CAN create master records (StockItem, Sales Agent, Debtor),
  add UDF-list options, and create SO documents. So everything below is
  implementable middleware-side; no manual data entry required.

**Data-alignment caveat:** the SKU code map (ERP code → AutoCount ItemCode) must be
re-verified against a LIVE channel — a prior census used a stale local DB copy and
is not trustworthy. See §6. Everything else in this spec was read from the LIVE UI.

---

## 1. New endpoints the middleware must add

| Endpoint | Purpose |
|---|---|
| `POST /SalesOrder/create` | Create the SO document (SDK `SalesOrderCommand`). Core. |
| `POST /StockItem/upsert` | Create a stock item if the ItemCode doesn't exist (§4). |
| `POST /SalesAgent/upsert` | Create a sales agent if the code doesn't exist. |
| `PUT  /UDFList/add` | Add an option to a UDF list (BRANDING / VENUE). |
| `POST /Debtor/upsert` | Only if per-customer debtors are ever needed (default: not — §3). |

`SalesOrder/create` should run the **pre-flight master check** (§5) internally so a
single call is enough; the upsert endpoints are also exposed for the ERP to call
eagerly on master creation.

---

## 2. Field mapping (ERP → AutoCount SO)

### Header
| ERP field | AutoCount | Notes |
|---|---|---|
| `doc_no` | **DocNo** | Our SO number written directly (owner confirmed). |
| `so_date` | DocDate | direct |
| customer | **DebtorCode = `300-C002`** + DebtorName = customer name | fixed account + name override (§3) |
| `agent` | SalesAgent | controlled → auto-create if missing (§5) |
| `sales_location` | SalesLocation | normalize to an AC location code (KL/PG/SRW/SBH/…) |
| `branding` | **SOUDF_BRANDING** | UDF; auto-add option if missing |
| `venue` | **SOUDF_VENUE** | UDF; auto-add option if missing |
| `address1..4` | InvAddr1..4 | free text, direct |
| `phone` | Phone1 | free text |
| `ref` | Ref | free text |
| `po_doc_no` | SOUDF_ToPONo | free text |
| `remark2` | Remark2 | "stock status" e.g. MATTRESS/ACC |
| `line_delivery_date` | SOUDF_PDate | direct |
| `balance_centi` | SOUDF_BALANCE | info only |

### Line
| ERP | AutoCount | Notes |
|---|---|---|
| `item_code` (via SKU map) | **ItemCode** | controlled → auto-create if missing (§4) |
| composed variant string | **ItemDescription (Description 2)** | the full "Divan 10\"/Gap 14\"/Col …" string; sofa fabric/leg/seat appended |
| `qty` | Qty | |
| `unit_price` | UnitPrice | |
| `uom` | UOM | |
| total | Amount | or let AC compute |

### Sofa lines (special)
AutoCount has **one item per sofa model per supplier** (SET UOM, e.g. `DSL-8060 SOFA`,
`AMN-SF9028 SOFA`, `HOK-5535 SOFA`). AutoCount does **not** subdivide compartments.
So every ERP compartment SKU (`5535-1A(LHF)`, `5535-2S`, …) resolves to the **one
parent code**, and the compartment (`2A(LHF)`, `Col:`, seat size…) goes into
**Description 2**. Supplier prefix → creditor: `AMN`→400-A004, `DSL`→400-D004,
`HOK`→400-O002, `TD`→400-T005 (codes are `TD-SF####`), `TNS`→400-T004, `THL`→400-T002.

### Free text vs controlled (owner's rule)
- **Free text** (address, phone, ref, remark, Description 2, dates): write ERP data
  directly — new values just go in.
- **Controlled pickers** (ItemCode, SalesAgent, SalesLocation, BRANDING/VENUE UDF,
  Debtor): must exist in AutoCount → auto-provision in §5.

---

## 3. Debtor (customer)

AutoCount uses **one fixed debtor account** and overwrites the name. So:
`DebtorCode = 300-C002` (company name in AC = "CUSTOMER"), `DebtorName` = the actual
customer name (free text). **No per-customer debtor alignment or creation.**

---

## 4. Auto-creating a StockItem (default field template)

When a line's ItemCode is not in AutoCount, create it via the SDK with these
defaults (profiled from the existing book — company-level conventions):

| Field | Value |
|---|---|
| ItemCode | the AutoCount code from the SKU map |
| Description | ERP product name |
| ItemGroup | ERP category → AC group (MATTRESS/BEDFRAME/SOFA/ACC/BEDLINES/DINING/CARPET/DIFFUSER/OTHER/TRANS) |
| **BaseUOM = SalesUOM = PurchaseUOM** | MATTRESS→UNIT, BEDFRAME→SET, SOFA→SET, DINING→PCS, ACC/BEDLINES/CARPET/DIFFUSER/OTHER→UNIT |
| ItemType | (blank) |
| TaxType | (blank) |
| **CostingMethod** | `1` |
| StockControl | `T` |
| IsSalesItem / IsPurchaseItem | `T` / `T` |
| HasSerialNo / HasBatchNo | `F` / `F` |
| MainSupplier | the item's supplier creditor code (from the ERP supplier binding; sofa = prefix rule above) |
| IsActive | `T` |

**Guardrail:** flag every auto-created item (e.g. a UDF/CostCode marker or a
"pending review" list) so Finance can confirm accounting setup. Never let the push
silently create half-configured items in bulk.

Service items (DISPOSE, TRANSPORTATION CHARGES, STORAGE, …) already exist in
AutoCount with the ERP code == AC code, so they self-resolve (no create needed).

---

## 5. Pre-flight master provisioning (this is what stops "new thing → bug")

Before `SalesOrder/create` builds the document, for each referenced master:

1. **ItemCode** — resolve ERP code → AC code via the SKU map. If the AC item does
   not exist → `StockItem/upsert` (§4). Sofa → parent code + Description 2.
2. **SalesAgent** — map ERP salesperson → AC agent (name = code). If missing →
   `SalesAgent/upsert` (code + name). (2990 staff / non-sales excluded.)
3. **SalesLocation** — normalize ERP `sales_location` to an AC location code
   (KL/PG/SRW/SBH/HQ/…). New warehouses are rare; create only if genuinely new.
4. **BRANDING / VENUE (UDF list)** — if the value isn't in the UDF option list →
   `UDFList/add`. (BRANDING options today: AKEMI/MYLATEX/DUNLOPILLO/ZANOTTI/ERGOTEX/
   NONE/HOUZS; HOUZS was added 2026-08-06.)
5. **Debtor** — always `300-C002`; nothing to create.

Only after all masters resolve/exist does the SO document get created. This makes
the write-back idempotent w.r.t. new master data — adding a new SKU/agent/branding/
venue in the ERP can't break the push, because the push provisions it first.

---

## 6. Payment

A Sales Order is **non-financial** in AutoCount — no payment posts through it. The
`PAYEMENT` UDF (a receipt-ref string) and `SOUDF_BALANCE` can carry payment *info*
only. Real receipts are a separate AR document + a separate endpoint (not in scope).

---

## 7. Open items before go-live

1. **Re-verify the full SKU map against a LIVE channel** (middleware
   `StockItem/getAll`, or a LIVE read-only SQL login). The map that a stale local DB
   produced is not trustworthy; master field templates in §4 ARE valid (company
   conventions don't drift between copies).
2. Implement the five endpoints (§1) in the middleware using the AutoCount SDK.
3. Decide the DocNo collision policy (our number as AC DocNo directly, vs stored in
   Ref/UDF) with AutoCount's document-numbering settings.
4. Flip `AUTOCOUNT_WRITES_DISABLED` to `false` once the create path is verified on a
   test book.

---

## 8. Middleware maintainer task list (.NET + AutoCount SDK)

The middleware already connects to the LIVE book via the SDK and has working read
endpoints. Add the writes below, reusing the same auth (`X-API-KEY`, `X-Request-ID`).

**A. `POST /SalesOrder/create`** (core)
1. Run the pre-flight master check (task D) so every referenced master exists first.
2. `SalesOrderCommand.Create()` → data object. Set header:
   DocNo = our `doc_no`; DocDate; DebtorCode = `300-C002`; DebtorName = customer name;
   SalesAgent; SalesLocation; InvAddr1..4; Phone1; Ref; Remark2; SOUDF_ToPONo;
   SOUDF_PDate; SOUDF_BALANCE; and UDFs SOUDF_BRANDING, SOUDF_VENUE (`SetUDFValue`).
3. For each line: add a detail row — ItemCode (resolved via SKU map; sofa → parent
   code), Qty, UnitPrice, UOM, ItemDescription = the composed variant string (Desc2).
4. `Save()`. Return the AutoCount DocNo + status.
5. **Idempotent:** if a SO with our DocNo already exists, skip and return it (safe retry).

**B. `POST /StockItem/upsert`**
- If ItemCode exists → return "exists". Else create with §4 defaults (CostingMethod=1,
  StockControl/IsSalesItem/IsPurchaseItem=T, Serial/Batch=F, UOM by group, MainSupplier
  from payload). Flag auto-created items for Finance review.

**C. `POST /SalesAgent/upsert`** — create code+description if the agent code is missing.

**D. Pre-flight master provisioning** (called inside A, also exposed):
- ItemCode → B (per line); SalesAgent → C; BRANDING/VENUE → `PUT /UDFList/add` if the
  option isn't in the list; SalesLocation → normalize to an existing code (don't
  auto-create warehouses); Debtor → always `300-C002`, nothing to create.

**E. `PUT /UDFList/add`** — add an option to a UDF list (BRANDING / VENUE) via the
UserDefinedList maintenance if not present.

SDK areas to use (confirm exact classes in your SDK version): SalesOrderCommand /
SalesOrderDataObject + SetUDFValue for the SO; Item create for StockItem; SalesAgent
maintenance; UserDefinedList maintenance for UDF options.

**F. Test + go-live**
1. Point the middleware at a NON-live test account book.
2. Call `/SalesOrder/create` with one full sample SO (new agent + new item to exercise
   auto-provisioning). Confirm in AutoCount: header, line ItemCodes, Description 2,
   SOUDF_BRANDING/VENUE all correct.
3. Switch back to the LIVE book; on the ERP side set `AUTOCOUNT_WRITES_DISABLED = false`
   and wire the ERP SO-save to call `/SalesOrder/create`.

**Still owed before go-live (ERP side, not middleware):** re-verify the ERP-code →
AutoCount-ItemCode map against LIVE (a prior census used a stale local copy). Field
templates and master alignment in this doc are already LIVE-verified.

---

## 9. ACTUAL implementation: the iNiState `syncSalesOrder` Logic job

Discovered 2026-08-07 on the integration server (DESKTOP-TDH50IT): the AutoCount
integration is **iNiState** (`api.inistate.com`) driving jobs, NOT a bespoke .NET
middleware. AutoCount↔ERP syncs are iNiState jobs. Two kinds:
- **SQL/hook jobs** — run a `SELECT` on the AutoCount DB, POST rows to an ERP hook.
  READ-only (AutoCount → ERP). Cannot create documents.
- **"Logic" jobs** — carry an AutoCount **user login**, i.e. they log into AutoCount and
  act **through the SDK** → they CAN create documents safely (business logic, not raw SQL).

**A `syncSalesOrder` Logic job already exists but is `enabled:false`** (hook
`28186-SyncSalesOrder`). So the write-back path is already chosen and half-built — finish
its Logic and enable it. Reuse this; no bespoke SDK project. Test book `AED_TESTING` exists.

### 9a. The two owner requirements (2026-08-07)

**(1) It must do EVERYTHING — every order writes, and any missing master is auto-created.**
The Logic job runs the pre-flight (§5) on every SO: for each ItemCode / SalesAgent it
creates the master via SDK if absent (§4 defaults); adds BRANDING/VENUE UDF options if
absent. So a brand-new SKU or agent never blocks a write — the job provisions it first,
then creates the SO. No manual AutoCount setup, ever.

**(2) The ON/OFF switch lives on the ERP side — no server/UltraViewer access to toggle.**
Control belongs to the ERP, not to enabling/disabling the job on the box. Design:
- The ERP is the **initiator + gatekeeper**. Add a runtime, admin-flippable toggle in the
  ERP (a `scm.sync_config` row / settings flag surfaced in the ERP admin UI — NOT the
  compile-time `AUTOCOUNT_WRITES_DISABLED` constant, which needs a deploy).
- When ON: on SO save (or via a queue), the ERP exposes the SO as "pending writeback".
- The iNiState `syncSalesOrder` job stays **always enabled** and polls the ERP's
  pending-writeback endpoint (mirroring how the other jobs poll on a 5s interval); when
  the ERP toggle is OFF, that endpoint returns nothing, so nothing is written.
- Net: staff flip writeback on/off from the ERP admin screen anytime; the server is never
  touched again.

### 9b. Logic (AutoCount SDK), per pending ERP SO
1. Pre-flight masters (§5) — create item/agent, add UDF options as needed.
2. Create SO via `SalesOrderCommand`, all fields per §2 (DocNo = our number; DebtorCode =
   300-C002 + name; SalesAgent; SalesLocation; InvAddr1-4; Phone1; Ref; Remark2;
   SOUDF_ToPONo/PDate/BALANCE; SOUDF_BRANDING/VENUE; lines: ItemCode + Qty + UnitPrice +
   UOM + ItemDescription(Desc2); sofa → parent code + compartment in Desc2).
3. Idempotent — skip if our DocNo already exists in AutoCount.
4. Report the AutoCount DocNo back so the ERP marks the SO synced (and won't resend).

Point `database` at **AED_TESTING** first; switch to **AED_HOUZS** only after it passes.

**Pre-req (do first):** the server `jobs` config holds **plaintext, weak credentials**
(AutoCount DB login + AutoCount user login). **Rotate both** before go-live.

**Roles:** owner → log into iNiState (the account already owns jobs 28183/28186/31126),
open job 28186, follow 9a/9b; Claude → ERP-side toggle + pending-writeback endpoint +
payload composer (`autocount-so-writeback.ts`, already built) + this spec. No third-party.

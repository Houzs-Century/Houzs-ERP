# AutoCount write-back — field alignment audit

**2026-08-14. Read-only audit, no source changed.** Every field the ERP sends to
AcSyncService on every operation (`create_so`, `create_po`, the four
conversions, `edit`, `cancel`), traced end to end: which ERP column the composer
reads → whether that is where the ERP keeps the value → whether anything opens
the master in AutoCount → what the C# does when it is missing.

Commissioned by the owner's question after the third instance of one bug in one
week: *"你看一下那些 sales agent venue 等等全部都对齐了"* — go through them all,
not just the one that broke. This is the deferred item at the top of
[`docs/autocount-writeback-golive-coe.md`](./autocount-writeback-golive-coe.md)
§5; that COE's §2 states the shape, and this document is the sweep for the rest
of it.

## The bug class, stated once

> **A value the ERP holds in one place, the composer reads from another, and
> nothing opens it on the AutoCount side.**

It surfaces in exactly three ways, and which one you get is decided by the C#,
not by the ERP:

| mode | mechanism | what you see |
|---|---|---|
| **FATAL-FK** | composer sends `null` → `Str()` turns a present-but-null key into `""` → the property is assigned **unconditionally** → `Save()` hits a foreign key → the WHOLE document is lost | six retries, then a `failed` outbox row carrying AutoCount's own constraint name |
| **SILENT-DROP** | composer sends `null` → `udf()` drops the key entirely → the field never reaches the book | nothing. No error, no outbox row, no log line |
| **SILENT-BLANK** | composer sends a key whose value is `null` on `/edit` → `Str()` → `""` → **overwrites** what the account book holds | nothing, until someone reads the AutoCount document |

`Set()` (AcSyncService.cs:907) swallows the exception from the *assignment*. It
does not protect `Save()`, and a foreign key is enforced at `Save()`. So
wrapping a field in `Set()` buys nothing against this bug class.

Three instances have already been paid for: `FK_SODTL_Location` (2026-08-11),
`ItemCodeError` (2026-08-13), `FK_SO_SalesAgent` (2026-08-13). This audit found
**8 more BROKEN fields and 6 AT RISK**, listed below by severity.

## The one-line summary

`mapOrPassthrough` returns `null` for any value its map has never heard of — and
`null` is the fatal value in every one of the three modes above. **The map is not
protecting anything.** Measured against the live book's own vocabularies
(harvested read-only 2026-08-06, committed at `backend/scripts/data/`):

| map | targets it can emit | are those targets real masters in the book? | values it currently DROPS |
|---|---|---|---|
| `AGENT_MAP` | 30 | **30 of 30 yes** | 37 agent names, **all 37 already sales agents in the book**, carrying 2,746 of the 13,015 historical SOs |
| `LOCATION_MAP` | 5 | 5 of 5 yes | `SUNWAY` — a real AutoCount location, 21 SOs |
| `VENUE_MAP` | 7 | 7 of 7 yes | 93 venue names, **84 of them already options in the book's own VENUE list**, carrying 9,111 SOs |
| `BRANDING_MAP` | 7 | 7 of 7 yes | `CARRESS`, `DUNLOP` (7 SOs) |

Reproduce: `npx tsx backend/scripts/check-autocount-field-alignment.mjs`
(the numbers above come from `backend/scripts/data/ac-fidelity-so-headers.json.gz`,
13,015 live-book SO headers exported 2026-08-11, cross-checked against
`autocount-venue-options.txt` and `autocount-so-writeback-mappings.json`).

---

# BROKEN

## 1. `Agent` on `create_so` — every ERP-created sales order [fix in flight]

*Fault 7 of the go-live COE. Recorded here in full because it is the template
every finding below is measured against, and because as of this branch it is
still live on `main`: `composeCreateSo` reads `header.agent`, and
`SO_HEADER_COLS` still does not select `salesperson_id`.*

| step | fact |
|---|---|
| ERP column read | `mfg_sales_orders.agent` (`SO_HEADER_COLS`, autocount-outbox.ts) |
| where the ERP keeps it | **`salesperson_id` → `scm.staff`.** `POST /mfg-sales-orders` writes `agent: body.agent ?? null`, and **no client ever sends `body.agent`** — neither `SalesOrderNew.tsx` nor `MobileNewSO.tsx`'s `soHeaderPatchFrom` has the key. `salesperson_id` is always stamped (`canAttributeOther ? body.salespersonId : callerStaffId`). Only the cutover import writes `agent`, from AutoCount's own `SalesAgent` text — and those rows carry `linked_ac_docno`, so `enqueueSoCreate` returns early for them |
| master opened? | **No.** `mastersOf` does `typeof body.Agent === 'string' ? … : ''`, so a `null` Agent opens nothing |
| C# assignment | `Set(() => so.Agent = Str(p, "Agent"))` — unconditional; `Str` turns present-null into `""` |
| failure | `Foreign Key Error (Constraint Name=FK_SO_SalesAgent)`, production 2026-08-13. FATAL-FK, whole document |
| blast radius | **100% of ERP-created sales orders.** Not a fraction — the column is structurally empty on every one of them |

`AGENT_MAP`'s own keys are `scm.staff` display names (`Anthony`, `Mei Ting`,
`Kar Jiun`, `Wei How`) — it was built for the column the composer is **not**
reading. `backend/scripts/data/agent-staff-binding.csv` is the other half of that
same mapping.

**Fix** — add `salesperson_id` to `SO_HEADER_COLS`, join `scm.staff.name`, and
read `agent ?? staff.name`. Then stop `mapOrPassthrough` returning `null`
(finding 9).

## 2. `Agent` on `create_po` — every purchase order

| step | fact |
|---|---|
| ERP column read | none. `readPoHeader` hard-codes `agent: null` for every PO |
| where the ERP keeps it | nowhere — `scm.purchase_orders` genuinely has no agent column. That is not the problem; sending `null` for it is |
| master opened? | **No.** `mastersOf` routes to `PurchaseAgents` only when `body.Agent` is a non-empty string |
| C# assignment | `Set(() => po.Agent = Str(p, "Agent"))` — unconditional, `""` |
| failure | `FK_PO_PurchaseAgent` — the constraint AcSyncService.cs:552-560 already names, hit on the live book 2026-08-12 when `OTHERS` was not yet a *purchase* agent. FATAL-FK |
| blast radius | **every PO the ERP would push.** Unproven live only because no PO has been pushed yet (AcSyncService.cs:601-606 says exactly that about the sibling `CreditorCode`) |

**Fix** — send a constant purchase agent (`OTHERS` exists in the book and is what
the FK chain was debugged with) and let `mastersOf` open it, or omit the key and
have `CreatePo` assign only when non-empty.

## 3. `SalesLocation` on `create_so` — whenever the state does not map

| step | fact |
|---|---|
| ERP column read | `mfg_sales_orders.sales_location` — correct column |
| what it contains | a **warehouse label**: `deriveSalesLocationFromState` resolves `customer_state` → `state_warehouse_mappings` → `warehouseLabel(wh)`, which prefers `warehouses.code` |
| composer | `SalesLocation: mapOrPassthrough(header.sales_location, LOCATION_MAP)` — **no `?? raw` fallback**, unlike the line-level location in `composeDetails`, which is `mapOrPassthrough(raw, LOCATION_MAP) ?? raw` in the same file |
| master opened? | only when non-empty — `mastersOf` does `addLoc(body.SalesLocation)` |
| C# assignment | `Set(() => so.SalesLocation = Str(p, "SalesLocation"))` — unconditional, `""` |
| failure | `FK_SO_SalesLocation`, named in AcSyncService.cs:556-560 as the second link of the chain, hit on the live book 2026-08-12. FATAL-FK |
| blast radius | every SO whose `customer_state` maps to a warehouse whose code is not one of `LOCATION_MAP`'s 16 keys, **plus** every SO with no `customer_state` at all (`deriveSalesLocationFromState` returns `null` for a missing state). `SUNWAY` alone is 21 historical SOs and is a real AutoCount location |

**Fix** — one character of asymmetry: `mapOrPassthrough(x, LOCATION_MAP) ?? x`,
the same fallback the line already has. `ensure-masters` then opens anything new.

## 4. `CreditorCode` on `create_po` — a PO whose supplier has no code

`composeCreatePo` sends `CreditorCode: header.creditor_code`, which is
`scm.suppliers.code` behind `supplier_id`. `CreatePo` assigns it **directly**
(`po.CreditorCode = Str(p, "CreditorCode")`, not even wrapped in `Set`). A
supplier row with a null/blank `code`, or a PO with a null `supplier_id`, sends
`""` → `FK_PO_Creditor`. `mastersOf` DOES open a creditor, but only when the code
is a non-empty string — so the empty case is exactly the one nothing covers.
Counted by the script.

## 5. `VENUE` — the owner's question, and the largest silent loss

| step | fact |
|---|---|
| ERP column read | `mfg_sales_orders.venue` — **correct column** (`resolvedVenueName`; explicit `body.venue` wins, else looked up from the stamped `venue_id`). `venue_id` is a FK to the empty, unused `scm.venues` |
| composer | `VENUE: mapOrPassthrough(header.venue, VENUE_MAP)` — `VENUE_MAP` has **7 entries** |
| the vocabulary it must cover | venue is deliberately free text — *"every roadshow hall is a one-off"* (mig 0229). The book's own dropdown holds **94 options** |
| master opened? | yes for a non-empty value — `mastersOf` emits `UdfOptions`, and `EnsureMasters` read-appends-writes the whole option set. **A pass-through would be safe by construction** |
| C# | `ApplyUdf` writes only the keys present; `udf()` on our side drops a null |
| failure | **SILENT-DROP.** No error, no outbox row, no log |
| blast radius | **9,232 of 13,015 live-book SOs (71%) carry a venue `VENUE_MAP` turns into null** — and **9,111 of those are already an option in the book's own list**. The top one, `MIDVALLEY EXHIBITION CENTRE`, is 1,091 orders. The ERP-side count is what the script reports |

**Fix** — pass the venue through when the map does not know it. Nothing to open
for 84 of the 93 names; `ensure-masters` opens the rest. This single change is
the answer to *"venue 对齐了吗"*.

## 6. `BRANDING` — the header column is empty on every ERP-created order

`composeCreateSo` reads `mfg_sales_orders.branding`. No client sends it
(`SalesOrderNew.tsx`, `MobileNewSO.tsx` both omit the key), so it is `NULL` on
every ERP-created SO. The value the business actually has is on the **lines**
(`mfg_sales_order_items.branding`, snapshotted from the catalog at line
creation), and the detail page derives `first_item_branding` from them for
display — the route's own comment says *"The header `branding` column is NULL on
essentially every SO"*. SILENT-DROP, ~100% of new orders. Separately, `CARRESS`
and `DUNLOP` exist in the book's history and `BRANDING_MAP` drops both.

**Fix** — fall back to the lines' branding, the same derivation the UI already
trusts; and pass unknown values through so `ensure-masters` opens the option.

## 7. `ToPONo` — reads a column PR #140 stopped writing

`composeCreateSo` sends `ToPONo: header.po_doc_no`. `frontend/src/pages/scm-v2/so-relationship-map.ts:42-48` states it plainly: PR #140 dropped the Customer PO card, **no Houzs surface writes `po_doc_no` or `customer_po`**, and the value the operator types lands in `customer_so_no` — which `SO_HEADER_COLS` does not even select. The cutover import never wrote `po_doc_no` either. SILENT-DROP, ~100%.

**Fix** — `po_doc_no ?? customer_po ?? customer_so_no`, mirroring the desktop
detail page's own `refOf` precedence.

## 8. `InvAddr3` / `InvAddr4` — the customer's town and postcode never arrive

`composeCreateSo` maps `address1..address4` → `InvAddr1..InvAddr4`. Only the
cutover import ever wrote `address3` / `address4`; an ERP-created order keeps the
same facts in `city`, `postcode` and `customer_state`, and `SO_HEADER_COLS`
selects none of the three. So AutoCount's document carries the street lines and
**no town, no postcode, no state** — on the customer address a delivery is
printed from. `InvAddr1..4` are assigned directly (not through `Set`), so the two
blanks are written every time. SILENT-DROP / SILENT-BLANK, ~100% of new orders.

**Fix** — pack `city` / `postcode` / `customer_state` into `InvAddr3` /
`InvAddr4` (five ERP fields into AutoCount's four numbered lines needs ONE
decision written down, exactly as the DO/SI comment in `autocount-outbox.ts`
already says). Free text, no master, no FK — the only risk is a packing rule
nobody agreed.

---

# AT RISK

## 9. `mapOrPassthrough` returning `null` is itself the defect

Findings 1, 3, 5 and 6 are four faces of one function. It returns `null` for any
value not in its map, and `null` is: `""` on the two FK fields, and a dropped key
on the two UDFs. Yet **every target the four maps can emit is already a real
master in the live book** (table at the top), so the maps never protect against
sending something unknown — they only delete what they have not been told about.
Meanwhile `ensure-masters` exists precisely to open what the book lacks, and
`EnsureMasters` refuses to invent a UDF *list* while happily appending an
*option*.

**Fix** — make the pass-through the default (`map[k] ?? canonicalValue ?? raw`)
and let `ensure-masters` do its job. The maps stay as spelling corrections
(`SUTERA MALL` → `SUTERA MALL SOLO`), which is what they were harvested to be.

## 10. `soEditHeader` blanks eight header fields, against its own written contract

Its doc comment says *"A NULL VALUE IS OMITTED, NEVER SENT"*, and then the
function unconditionally emits `DebtorName`, `Attention`, `Ref`, `Phone1`,
`InvAddr1`, `InvAddr2`, `InvAddr3`, `InvAddr4` as `x ?? null`. Only
`Agent`, `SalesLocation`, `DocDate` and the UDFs are actually conditional.
`AcSyncService.Edit()` is `ContainsKey`-gated, so a present-null key reaches
`prop.SetValue(doc, "")`: **every edit of an SO blanks whatever the account book
holds in those eight fields whenever the ERP's column is null** — which, per
findings 7 and 8, is `ref`, `address3` and `address4` on essentially every
ERP-created order. Same shape in all four `DOWNSTREAM[*].header` builders
(`DebtorName`, `Ref`, `Phone1`, `Note`, `Description` via `str()`).

**Fix** — apply the function's own stated rule to all of its keys.

## 11. `mastersOf` cannot see an EDIT payload's header

`dispatchOne` calls `mastersOf(body)` for `create_so`, `create_po` **and
`edit`** — but an edit payload is `{DocType, DocNo, Header{…, UDF{…}}, Lines[]}`.
`mastersOf` reads `body.Agent`, `body.SalesLocation`, `body.CreditorCode` and
`body.UDF` at the **top level**, where an edit has none of them. It finds the
line items (it merges `Details` and `Lines`) and nothing else.

Harmless *today* only because `soEditHeader` sends exclusively values that
already exist in the book. It stops being harmless the moment finding 5 or 9 is
fixed: the first edit carrying a new VENUE would silently fail to open the
option, and a new agent would FK the edit.

**Fix** — have `mastersOf` fall back to `body.Header` for those four keys. One
line, and it must land in the same PR as any pass-through change.

## 12. `ensure-masters` opens stock locations — its own comment says it never does

`EnsureMasters`'s header block states: *"It never creates a LOCATION. A new
warehouse is a real business decision with stock consequences"*. Sixty lines
below, the `Locations` loop calls `lm.SaveLocation(e)` and logs
`ensure-masters CREATED location`. The code is newer than the comment and the
comment is what a reviewer reads.

Consequence: a line's location IS passed through raw when `LOCATION_MAP` does not
know it, so an ERP warehouse code the account book has never held **opens a new
stock location in a licensed book** on the first document that names it, with no
approval step. Counted by the script (`WAREHOUSE CODES:` line).

**Fix** — decide which behaviour is wanted and make the other one impossible.
The comment is the safer of the two.

## 13. The four conversions send `Ref: null` and no `Description` at all

Every caller of `enqueueConvert` (`delivery-orders-mfg.ts` ×2, `grns.ts` ×2,
`sales-invoices.ts`, `purchase-invoices.ts`) omits `ref` and `docDate`, so the
body is always `{DocNo, DocDate: null, Ref: null, DtlKeys?}`. In
`SalesHeader` / `PurchaseHeader`:

- `Set(() => doc.Ref = Str(p, "Ref"))` → `""`
- `Set(() => doc.Description = Str(p, "Description"))` → `""` (the key is never sent)
- `DocDate` is correctly left alone when null — the target keeps the transfer's date, which on a backlog drain is the **drain day**, not the ERP document's date

Meanwhile the ERP *does* hold a reference for each: `delivery_orders.ref`,
`grns.delivery_note_ref`, `sales_invoices.ref`, `purchase_invoices.supplier_invoice_ref`
— every one of them is already mapped in `DOWNSTREAM[*].header` for the EDIT
path. So the ERP's own reference reaches the account book only if somebody later
edits the document. Whether the `""` also *overwrites* something is unverified:
the purchase side transfers with `transferMaster: true`, which the C# comment
says copies the source header's master (supplier / currency / terms), and
whether `Ref` and `Description` travel with it was not established from here.

**Fix** — pass `ref` and `docDate` at the six call sites; they are already
plumbed through `enqueueConvert`'s signature and unused.

## 14. `item_group` is read and thrown away

`SO_ITEM_COLS` / `PO_ITEM_COLS` select `item_group`, `soLine` carries it, and
`AcDetail` has no field for it — so `mastersOf` never emits `ItemGroup` and
`EnsureMasters` defaults every newly opened item to `OTHER`. The module guide
already says the ERP→AutoCount group mapping is an owner decision; this records
that the ERP-side value is available and currently discarded at the composer.

---

# SAFE — checked, and fine

| field | why it is fine |
|---|---|
| `DocNo`, `DocDate` (`so_date`, `po_date`) | direct assignment, no master, ERP is authoritative and always populates them |
| `DebtorCode` | the fixed `300-C002` by owner convention; deliberately never opened. `mastersOf`'s comment states the rule. The script counts how many SOs carry a different `debtor_code` of their own so the size of the discard is visible |
| `DebtorName` / `Attention` | `debtor_name` is the only customer-name column on the table (no `customer_name` exists) and the create route requires it |
| `Phone` → `Phone1` | correct column, E.164-normalised on write |
| `processing_date` → UDF `PDate` | correct column since mig 0286 unified it; `acUdfDate` normalises the shape; a blank is dropped, never blanked. **The one field where the two-column trap was already found and closed** — `proceeded_at` is the retired twin |
| line `ItemCode` | resolved by `resolveAcItemCode` with an explicit refuse-or-canonical chain, opened by `ensure-masters`, and audited separately by `check-autocount-ambiguous-items.mjs` |
| line `Location` | passes through raw when unmapped and IS opened — the asymmetry with the header (finding 3) is the bug, this half is right |
| line `Desc2` | composed or echoed by the D9 collapse, refused rather than invented |
| line `Qty` on a GRN | `qty_accepted`, deliberately not `qty_received` — reasoned in `DOWNSTREAM.GR` |
| `cancel` | payload is `{DocType, DocNo}` only; `DocNo` resolved at drain from `linked_ac_docno`, with the GRN mis-link refusal in front of it |
| `DtlKeys` on a conversion | refuses rather than under-naming a partial transfer |
| edit line identity | keyless lines refused on both sides; `persistLineKeys` verifies the zip by ItemCode **and** Desc2 before storing |

---

# Recommended fix order

1. **`salesperson_id` into `SO_HEADER_COLS`** and read it for `Agent` (finding 1). Unblocks every ERP-created SO. **In flight** — COE §5.
2. **Stop `mapOrPassthrough` returning null** for Agent, SalesLocation, VENUE, BRANDING (findings 3, 5, 6, 9) — *and* fix `mastersOf`'s edit blindness (11) in the same PR, or the pass-through opens nothing on an edit.
3. **A constant purchase agent** for `create_po` (finding 2), before the first PO is ever pushed.
4. `po_doc_no ?? customer_po ?? customer_so_no` (7); branding from the lines (6).
5. `soEditHeader`'s own rule applied to all its keys (10).
6. `ref` + `docDate` at the six conversion call sites (13).
7. Decide the location-creation policy and make the comment and the code agree (12).
8. Address packing (8) — needs one owner decision about which ERP fields go into `InvAddr3` / `InvAddr4`.

# What this audit could NOT verify

- **Whether `""` is genuinely rejected by every one of these FKs.** The live book
  holds 23 SO rows with `SalesAgent = ''` (0 nulls) in the 2026-08-11 export, so
  an empty string is *storable* on a legacy row — most likely because the
  constraint was added `WITH NOCHECK`, which is normal for an AutoCount upgrade.
  What is proven is that the constraint refused it on 2026-08-13, exactly as
  `FK_SODTL_Location` refused an empty location on 2026-08-11.
- **Whether a UDF value that is not in the dropdown throws or is silently
  accepted.** `ApplyUdf` wraps every write in `Set()`, so either way it fails
  invisibly. This is moot while `mastersOf` opens the option first — it stops
  being moot on the edit path (finding 11).
- **The ERP-side row counts.** Every number in this document comes from the
  committed live-book export (AutoCount's side, 2026-08-11) or from source. The
  ERP-side counts need one dispatch of the workflow below; a `workflow_dispatch`
  cannot run until the file is on `main`.
- **`AGENT_MAP` against `scm.staff` as it stands today.** The map's keys look
  like staff display names and `agent-staff-binding.csv` corroborates it, but the
  current staff roster lives only in production — the script's
  *"reading salesperson_id → scm.staff.name instead would resolve N of those M"*
  line is the measurement, and it has not been run yet.

# The tooling

- `backend/scripts/check-autocount-field-alignment.mjs` — read-only, SELECTs
  only, no DDL, no writes, no transaction; exits 0 for every legitimate answer
  and non-zero only for an unreachable database. It asks
  `information_schema.columns` first and reads only columns that exist, so a
  renamed column reports as *"NOT PRESENT on the table"* rather than as a zero
  somebody believes.
- **The maps are imported from the composer, never retyped** — which is why it
  runs under `tsx` (`npx tsx scripts/check-autocount-field-alignment.mjs`, the
  same shape as `recompute-so-allocation.yml`). The report cannot drift from what
  the write-back actually does.
- `.github/workflows/autocount-field-alignment.yml` — `workflow_dispatch` only,
  `secrets.DATABASE_URL`, its own concurrency group, never the deploy's.

Verified before shipping by running the whole script against a synthetic fixture
covering an imported SO, an ERP-created SO, an unmapped-agent SO and a
locationless SO — every branch produced the expected line.

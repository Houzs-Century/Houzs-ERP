# AutoCount write-back — field alignment audit

> **STATUS, 2026-08-14 (second pass).** Every BROKEN finding below is now
> FIXED, plus AT-RISK findings 9, 10, 11, 12 and half of 13. Each section keeps
> its original trace and carries what was done and the production number it was
> measured against. **What remains open is listed in [Still open](#still-open),
> and it is three items, all of them owner decisions.** The numbers in the
> original text were taken over 112 writable sales orders on 2026-08-13; the
> re-run on 2026-08-14 (workflow run 31808445421) found **115**, and where the
> two disagree the 115-row figure is the one quoted, because it was re-run at
> the moment of writing rather than recalled.

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

`mapOrPassthrough` returned `null` for any value its map had never heard of — and
`null` is the fatal value in every one of the three modes above. **The map was not
protecting anything.** Measured against the live book's own vocabularies
(harvested read-only 2026-08-06, committed at `backend/scripts/data/`):

| map | targets it can emit | are those targets real masters in the book? | values it currently DROPS |
|---|---|---|---|
| `AGENT_MAP` | 30 | **30 of 30 yes** | 37 agent names, **all 37 already sales agents in the book**, carrying 2,746 of the 13,015 historical SOs |
| `LOCATION_MAP` | 5 | 5 of 5 yes | `SUNWAY` — a real AutoCount location, 21 SOs |
| `VENUE_MAP` | 7 | 7 of 7 yes | 93 venue names, **84 of them already options in the book's own VENUE list**, carrying 9,111 SOs |
| `BRANDING_MAP` | 7 | 7 of 7 yes | `CARRESS`, `DUNLOP` (7 SOs) |

**FIXED.** The function is now two, and both names state what `null` means:
`bookSpelling` (the book's own spelling of a value it already knows, `null`
otherwise — kept for `resolveAcAgent`, where `null` genuinely has to refuse) and
`bookSpellingOrOwn` (the book's spelling, else the ERP's own value verbatim for
`/ensure-masters` to open). `mapOrPassthrough` no longer exists; the name was the
trap, and four fields were composed on the strength of it.

**Every number in that table is REGENERATED, not typed.** It is the first section
of `backend/scripts/check-autocount-field-alignment.mjs`, which runs the real
`mapOrPassthrough` over `backend/scripts/data/ac-fidelity-so-headers.json.gz`
(13,015 live-book SO headers, exported 2026-08-11) and cross-checks the survivors
against `autocount-venue-options.txt` and `autocount-so-writeback-mappings.json`.
Dispatch the workflow, or run `npx tsx backend/scripts/check-autocount-field-alignment.mjs`;
that section reads the committed export, not the database.

---

# BROKEN

## 1. `Agent` on `create_so` — every ERP-created sales order [FIXED, #2148]

*Fault 7 of the go-live COE. Kept in full because it is the template every
finding below is measured against. The table below describes `main` before
#2148; that PR did what this finding prescribed and one thing more —* `agent`
*is now also STAMPED at create from the salesperson, so the fallback is the
backstop rather than the only source. See* `docs/modules/autocount-writeback.md`
*§7n.*

**What #2148 did NOT do, so finding 9 stays open:** `mapOrPassthrough` still
returns `null` for an unmapped value, and still does so for `SalesLocation`,
`VENUE` and `BRANDING`. The agent alone routes through `resolveAcAgent`, which
passes an unmapped **`scm.staff` name** through and lets `/ensure-masters` open
it — but deliberately NOT the raw `agent` free text, because that column holds
bare uuids and "Unassigned" in production and the service opens an agent under
exactly the string it is given. Finding 9's blanket "make the pass-through the
default" needs that distinction per field: a value with a trustworthy writer may
pass through, a free-text column with none may not.

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

## 2. `Agent` on `create_po` — every purchase order [FIXED]

**Fixed:** `readPoHeader` sends the constant `AC_PURCHASE_AGENT` (`OTHERS`) and
`composeCreatePo` floors the field at it, so a null can never be sent again.
`mastersOf` already routed a payload carrying a `CreditorCode` to
`PurchaseAgents`, so the value is opened in the right table. **60 of 60**
unpushed purchase orders were sending the empty string; all 60 now name a
purchase agent. Which purchase agent AutoCount's own reports group by is an
OWNER decision, and `AC_PURCHASE_AGENT` is the single place it is written down.

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

## 3. `SalesLocation` on `create_so` — whenever the state does not map [FIXED]

**Fixed, and the audit's own prescription would not have been enough.** The
recommendation below was `mapOrPassthrough(x, LOCATION_MAP) ?? x`. Re-measured on
2026-08-14 that fixes **zero** orders: **21 of 115** unpushed sales orders fail
this field and **every one of them has a BLANK `sales_location`, not an unmapped
one** — the blast-radius sentence below already named that half
(`deriveSalesLocationFromState` returns `null` for a missing state) and it turns
out to be all of it. So `soSalesLocation` does both: pass the value through when
the map does not know it, and fall back to the stock location the document's own
LINES resolve to when there is none at all. The line fallback opens no master —
`requireLocation` has already refused any line with no location, and `mastersOf`
is collecting that same code off the line.

**BE PRECISE ABOUT WHAT THAT BUYS, because the after-run says 21 of 115 STILL
send nothing.** The line fallback rescues none of them, and the report was made
to say why rather than leave the number hanging:

| | |
|---|---|
| **13** | have NO live line at all — nothing to sell, so no warehouse to inherit. `MissingSalesLocationError` |
| **8** | have lines carrying no `warehouse_id`. `MissingLocationError`, which already refused them before this change |

So the gain here is **not** "21 orders now write". It is that a document with no
location is a `skipped` outbox row naming its remedy instead of `""` sent into
`FK_SO_SalesLocation`, six retries and a lost document — and that the pass-through
half now protects the unmapped case, which production does not exhibit today but
`deriveSalesLocationFromState` can produce any time a warehouse code changes.

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

## 4. `CreditorCode` on `create_po` — a PO whose supplier has no code [FIXED]

**Fixed:** `composeCreatePo` raises `MissingCreditorError` rather than sending
the empty string — the same shape as `MissingAgentError`, and for the same
reason: the document cannot land either way, so the refusal loses no successful
write and turns a 500 in the AutoCount host's log into a `skipped` outbox row
naming the supplier. **0 of 60** unpushed purchase orders are in that shape today
(measured 2026-08-14), so this is the guard for the first one, not a repair.

`composeCreatePo` sends `CreditorCode: header.creditor_code`, which is
`scm.suppliers.code` behind `supplier_id`. `CreatePo` assigns it **directly**
(`po.CreditorCode = Str(p, "CreditorCode")`, not even wrapped in `Set`). A
supplier row with a null/blank `code`, or a PO with a null `supplier_id`, sends
`""` → `FK_PO_Creditor`. `mastersOf` DOES open a creditor, but only when the code
is a non-empty string — so the empty case is exactly the one nothing covers.
Counted by the script.

## 5. `VENUE` — the owner's question, and the largest silent loss [FIXED]

**Fixed:** `bookSpellingOrOwn(header.venue, VENUE_MAP)`, so a venue the 7-entry
map has never heard of reaches the book instead of vanishing. **112 of 115**
unpushed sales orders were losing their venue silently.

**THE MASTER-OPENING CONSEQUENCE, IN NUMBERS.** The 112 carry **3 distinct
venues**, and **none of the three is already an option in the book's 94-option
VENUE list**: `2990s PJ` (110 orders), `AEON BIG KEPONG` (1), `AEON BIG PUCHONG`
(1). So this pass-through appends **3 options** to one dropdown. That is the
cheapest of the master-opening consequences and the most reversible — an option
is removed from AutoCount's own UDF maintenance screen, and `EnsureMasters`
read-appends-writes the whole set rather than replacing it.

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

## 6. `BRANDING` — the header column is empty on every ERP-created order [FIXED]

**Fixed:** `soBranding` reads the header, then the first live LINE's own
`branding` — the value the detail page has been showing as
`first_item_branding` all along. `branding` joined `SO_ITEM_COLS`. **70 of 115**
header-blank orders carry a line brand; **2** of those resolve to a brand the
account book knows, and the other **68 are deliberately dropped** — see below.
`CARRESS` and `DUNLOP` were ADDED to `BRANDING_MAP`, which takes the book-side
drop from 7 rows to 0.

**AND THIS IS THE ONE FIELD THAT DOES NOT PASS THROUGH. Production refuted the
first version of this fix.** Running the check on the branch that passed line
branding through printed exactly what it would OPEN as brands in the licensed
book:

```
2990s Sofa (44)   Accessories (8)   2990s Mattress (8)
2990 (3)          Bedframe (3)      Happi.S (2)
```

Four CATEGORIES and a company name. `mfg_products.branding` — which is what
`mfg_sales_order_items.branding` is snapshotted from — is simply not a brand
vocabulary, so `BRANDING_MAP` is now the **one allow-list of the four** and its
own comment says so. This is the distinction finding 1 already drew for the
agent, arriving from the other direction: *a value with a trustworthy writer may
pass through, a column with none may not.* The check prints the would-open list
on every run so the decision stays reviewable — if that list ever becomes
all-brands, it is worth revisiting.

It is also why `so-display-branding.ts`'s rule is not reused wholesale: besides
needing a catalog read (which would make the composer impure), it falls back to
the pseudo-brand `BEDFRAME` for a bedframe-only order, and `Bedframe` is one of
the six values above.

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

## 7. `ToPONo` — reads a column PR #140 stopped writing [FIXED]

**Fixed:** `soCustomerRef` reads `po_doc_no ?? customer_po ?? customer_so_no`,
newest-writer last so a cutover-imported order keeps AutoCount's own text; both
new columns joined `SO_HEADER_COLS`. `ref` is deliberately NOT in the chain —
it goes out as the document's `Ref`, and sending it twice would put the same
string in two AutoCount fields. **3 of 115.**

`composeCreateSo` sends `ToPONo: header.po_doc_no`. `frontend/src/pages/scm-v2/so-relationship-map.ts:42-48` states it plainly: PR #140 dropped the Customer PO card, **no Houzs surface writes `po_doc_no` or `customer_po`**, and the value the operator types lands in `customer_so_no` — which `SO_HEADER_COLS` does not even select. The cutover import never wrote `po_doc_no` either. SILENT-DROP, ~100%.

**Fix** — `po_doc_no ?? customer_po ?? customer_so_no`, mirroring the desktop
detail page's own `refOf` precedence.

## 8. `InvAddr3` / `InvAddr4` — the customer's town and postcode never arrive [FIXED]

**Fixed, and the one decision the audit said needed making is made and written
down** — in `soInvoiceAddress`'s own doc comment, which is where a reader will be
standing when they need it:

| AutoCount | ERP |
|---|---|
| `InvAddr1` | `address1` |
| `InvAddr2` | `address2` |
| `InvAddr3` | `address3`, else `postcode` + `city` |
| `InvAddr4` | `address4`, else `customer_state` |

`address3` / `address4` WIN where they are populated, because only the cutover
import ever wrote them and that text is AutoCount's own. Postcode before town
and state on its own line is the Malaysian postal order (`43300 SERI KEMBANGAN`
then `SELANGOR`). Free text, no master, no foreign key. **94 of 115.**

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

## 9. `mapOrPassthrough` returning `null` is itself the defect [FIXED]

**Fixed, but NOT by changing that function's behaviour.** It has callers whose
meaning of `null` is correct and load-bearing: `resolveAcAgent` must return
`null` for an unmapped raw `agent`, because that column holds bare uuids and
"Unassigned" in production and `/ensure-masters` opens an agent under exactly the
string it is given. Flipping the default would have written permanent garbage
master data into a licensed book — the distinction #2148 already drew. So the
function was SPLIT, and both halves are named after what their `null` means:
`bookSpelling` (kept, for the agent) and `bookSpellingOrOwn` (the pass-through,
for location, venue and branding). Every caller was enumerated first: the
composer, `soEditHeader`, this document's own check script, and two test files.

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

## 10. `soEditHeader` blanks eight header fields, against its own written contract [FIXED]

**Fixed:** the function's own rule is now applied at the ONE place a header is
built, by a `present()` helper that strips every blank key — so the next field
added to it cannot reintroduce the defect. The same helper wraps all four
`DOWNSTREAM[*].header` builders and `composePoState`'s edit header, and
`AcDownstreamSpec.header` is typed `Record<string, string>` rather than
`Record<string, string | null>` so a null cannot be put back without a compile
error. On production that stops an edit blanking `ref` on **112 of 115** orders
and `address3` / `address4` on **94**.

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

## 11. `mastersOf` cannot see an EDIT payload's header [FIXED]

**Fixed IN THE SAME PULL REQUEST as the pass-through, which is what finding 9's
fix order demanded.** `mastersOf` reads every one of the four keys through one
accessor that falls back to `body.Header`, so a field added to either shape
cannot be opened on one path and dropped on the other. One extra thing had to
come with it: a PO EDIT carries no `CreditorCode` at all (`composePoState` sends
only `CreditorName` and `Description`), so the sales/purchase discriminator now
also reads `DocType` — opening an agent in the wrong table reads as success and
refuses the document anyway, which is the 2026-08-12 finding in one line.

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

## 12. `ensure-masters` opens stock locations — its own comment says it never does [FIXED — the COMMENT was corrected, not the code]

**The code was right and the text was the lie.** The owner's decision on
2026-08-11 was to open everything, and `docs/modules/autocount-writeback.md` §7e
already records it, so correcting the comment is what makes the two agree in the
direction the owner chose. The corrected block now states plainly that locations
ARE created, empty, and carries the number the decision costs: **19 of 25**
`scm.warehouses` codes are in neither `LOCATION_MAP` nor the book's location
list (re-measured 2026-08-14), so the first document naming one opens a new
stock location in a licensed book.

**That exposure is on the LINE path and this work did not widen it.** It has
behaved this way since the write-back went live. The header's `SalesLocation`
now falls back to the code the document's own line already carries, so the
header opens nothing the line was not opening on the same document — and **0 of
115** unpushed orders carry an unmapped non-blank `sales_location`, so the
header pass-through opens **zero** new locations today.

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

## 13. The four conversions send `Ref: null` and no `Description` at all [HALF FIXED]

**Fixed — the half that can destroy a value.** `enqueueConvert` now OMITS `Ref`
and `DocDate` when it has nothing, instead of sending null, so a conversion can
no longer write an empty string over whatever the transfer put there.

**Still open:** passing the ERP's own reference at the six call sites
(`delivery_orders.ref`, `grns.delivery_note_ref`, `sales_invoices.ref`,
`purchase_invoices.supplier_invoice_ref`). The parameter is plumbed and the
composer honours it — there is a test for that — so this is six route edits and
no design. Left out to keep one reviewable pull request; see *Still open* below.

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

## 14. `item_group` is read and thrown away [OPEN — owner decision]

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
| line `Location` | passes through raw when unmapped and IS opened — the asymmetry with the header (finding 3) was the bug, this half was always right, and the header now falls back to this same value |
| line `Desc2` | composed or echoed by the D9 collapse, refused rather than invented |
| line `Qty` on a GRN | `qty_accepted`, deliberately not `qty_received` — reasoned in `DOWNSTREAM.GR` |
| `cancel` | payload is `{DocType, DocNo}` only; `DocNo` resolved at drain from `linked_ac_docno`, with the GRN mis-link refusal in front of it |
| `DtlKeys` on a conversion | refuses rather than under-naming a partial transfer |
| edit line identity | keyless lines refused on both sides; `persistLineKeys` verifies the zip by ItemCode **and** Desc2 before storing |

---

# Recommended fix order — all of it DONE except three items

1. ~~**`salesperson_id` into `SO_HEADER_COLS`** and read it for `Agent` (finding 1).~~ **DONE, #2148** — and `agent` is stamped at create too, so new orders carry it in the column the reports read.
2. ~~**Stop `mapOrPassthrough` returning null** for SalesLocation, VENUE, BRANDING (3, 5, 6, 9) — *and* fix `mastersOf`'s edit blindness (11) in the same PR.~~ **DONE.** The function was SPLIT rather than flipped, so the agent's deliberate refusal survives; 11 landed in the same commit, as this line required.
3. ~~**A constant purchase agent** for `create_po` (2), before the first PO is ever pushed.~~ **DONE.** No PO has been pushed yet, so this landed ahead of the first one, which is where the whole value of it was.
4. ~~`po_doc_no ?? customer_po ?? customer_so_no` (7); branding from the lines (6).~~ **DONE.**
5. ~~`soEditHeader`'s own rule applied to all its keys (10).~~ **DONE**, at the one place a header is built, and extended to the four `DOWNSTREAM` builders and the PO edit.
6. `ref` + `docDate` at the six conversion call sites (13). **HALF DONE** — the null no longer goes out; passing the real reference is the open half.
7. ~~Decide the location-creation policy and make the comment and the code agree (12).~~ **DONE** — the comment was corrected to the code, which is the direction the owner's 2026-08-11 decision already pointed.
8. ~~Address packing (8).~~ **DONE.** The decision is made and lives in `soInvoiceAddress`'s doc comment.

# Still open

Three items, and every one is a decision rather than a defect:

| # | what | why it is not in this pass |
|---|---|---|
| 13 (half) | pass `ref` / `docDate` at the six `enqueueConvert` call sites | six route edits with no design in them; kept out to keep one reviewable pull request. The parameter is plumbed, the composer honours it, and a test pins that |
| 14 | map the ERP's `item_group` onto AutoCount's own groups | every newly opened item lands in `OTHER`. Which group a new product shows up under in AutoCount's reports is the owner's call, not a guess |
| 2 (residual) | WHICH purchase agent every ERP purchase order should name | `OTHERS` is what the FK chain was debugged with and it exists in the book. If the owner wants POs attributed to a real buyer, `AC_PURCHASE_AGENT` is the one place to change, and it would then need a column on `scm.purchase_orders` and a picker |
| new | **8 sales agents would be opened in the licensed book, and one is called `Test Sales Director`** | Not caused by this work — it is #2148's accepted "an unmapped `scm.staff` name is opened" rule, and it is only visible now because the report was fixed to measure the composer instead of the map. The 8: `Scarlett Chong Kar Yin` (38 orders), `Kah Wai` (20), `Bernard` (14), `Ltrey` (12), `Frankie Lee Boon ping` (7), `NG PENG CHUEN` (3), `Test Sales Director` (1), `Lim` (1). Two of them read as test or partial rows. The remedy is `scm.staff` hygiene or an addition to `AGENT_MAP`, not a code change, so it is the owner's |

| 12 (residual) | 21 sales orders still cannot be written at all | 13 have no live line, 8 have lines with no warehouse. Both are named `skipped` rows now rather than lost documents, but they are data to fix, not code |

One thing was deliberately NOT done, and it is worth stating so the next reader
does not treat it as an oversight: **`AcSyncService.cs` was not changed except
in a comment.** `CreateSo` / `CreatePo` assigning `Agent`, `SalesLocation` and
`CreditorCode` unconditionally is what makes a blank fatal, and gating those on
non-empty would be the tidier fix — but the running binary lives on the AutoCount
host, nothing in this repository can rebuild or test it, and a change that cannot
be verified is a guess. Every fix above is therefore on the ERP side, where the
tests run.

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
- ~~**The ERP-side row counts.**~~ **RESOLVED 2026-08-14** by dispatching the
  workflow below (run `31808445421`, and again on the branch carrying the fixes).
  Every ERP-side number quoted in this document is from that run.
- ~~**`AGENT_MAP` against `scm.staff` as it stands today.**~~ **RESOLVED, and
  the answer was that the QUESTION had gone stale.** The run reported
  *"reading salesperson_id → scm.staff.name instead would resolve 16 of those
  112; 96 would still not resolve"* — which counted MAP HITS, while `resolveAcAgent`
  had passed an unmapped staff name through since #2148. The report was measuring
  a design the composer no longer had. Every ERP-side section of the script now
  calls the composer's own function instead, so the report says what the
  write-back would really send rather than what a map would.

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

**What the report ANSWERS changed with the fixes, 2026-08-14.** It used to ask
one question per field — *does the MAP resolve the column the composer reads* —
and that stopped being the right question the moment the composer grew a
decision of its own. Each ERP-side section now calls the composer's own function
(`resolveAcAgent`, `soSalesLocation`'s two steps, `bookSpellingOrOwn`,
`soBranding`, `soCustomerRef`, `soInvoiceAddress`) and prints two numbers:

- **how many orders still send NOTHING** for that field, and what that costs;
- **OPENS** — the distinct values that are not already a master in the book, so
  `/ensure-masters` would create them, listed by name with their order counts.

The second line is the one to read before approving a pass-through, and it is
why the venue consequence in finding 5 is three named options rather than an
adjective.

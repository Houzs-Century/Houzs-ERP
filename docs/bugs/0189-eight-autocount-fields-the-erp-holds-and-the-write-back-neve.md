## Eight AutoCount fields the ERP holds and the write-back never sent — one null, three ways to lose a document [high]

**Symptom.** The owner, after the third instance of one bug in one week: *"你看
一下那些 sales agent venue 等等全部都对齐了"*. Nothing looked wrong. Sales orders
pushed to AutoCount successfully and arrived with no venue, no town, no postcode,
no state, no customer reference and no brand; some did not arrive at all and
answered `Foreign Key Error (Constraint Name=FK_SO_SalesAgent)` /
`FK_SO_SalesLocation`; and every edit of an order quietly blanked whatever the
account book held in eight header fields. Two of the three failure modes produce
**no error, no outbox row and no log line**, which is why the question had to be
asked rather than noticed.

**Root cause, traced field by field against production** (read-only workflow
`autocount-field-alignment.yml`, run 31808445421, 2026-08-14; 115 sales orders
and 60 purchase orders that can still be written).

One helper, `mapOrPassthrough`, returned **`null`** for any value its map had
never heard of — despite its name, which promised the opposite. `null` is the
worst possible value in all three places it landed:

| mode | mechanism | fields |
|---|---|---|
| FATAL-FK | `Str()` turns a present-null into `""`, the property is assigned unconditionally, `Save()` hits a foreign key and the WHOLE document is lost | `Agent`, `SalesLocation`, `CreditorCode` |
| SILENT-DROP | `udf()` drops a null key, so the field never reaches the book | `VENUE`, `BRANDING`, `ToPONo` |
| SILENT-BLANK | a present-null on `/edit` reaches `prop.SetValue(doc, "")` and overwrites | `Ref`, `Phone1`, `DebtorName`, `Attention`, `InvAddr1..4` |

**And the maps never protected anything.** Measured against the live book's own
vocabularies, *every target all four maps can emit is already a master there* —
so dropping what they had not been told about protected against nothing and only
deleted it.

Underneath that sat the same shape found in `FK_SO_SalesAgent` on 2026-08-13:
**the ERP keeps the value in one column and the composer read another.**
`ToPONo` read `po_doc_no`, which PR #140 stopped writing — the operator's text
lands in `customer_so_no`. `BRANDING` read a header column that is NULL on every
ERP-created order, while the value sits on the LINES (the detail page has been
showing it as `first_item_branding` all along). `InvAddr3` / `InvAddr4` read
`address3` / `address4`, which only the cutover import ever wrote, while an
ERP-created order keeps the town, postcode and state in `city` / `postcode` /
`customer_state` — three columns `SO_HEADER_COLS` did not select at all.

| field | affected | failure |
|---|---|---|
| `VENUE` | **112 / 115** | silently never written |
| `InvAddr3` / `InvAddr4` | 94 / 115 | town, postcode and state never reach the document |
| `SalesLocation` | 21 / 115 | `FK_SO_SalesLocation` — **all 21 BLANK, none unmapped** |
| `Ref` on an edit | 112 / 115 | blanks the book |
| `ToPONo` | 3 / 115 | reads a column nothing writes |
| `BRANDING` | header NULL on 115 / 115 | the value is on the lines |
| PO `Agent` | **60 / 60** | `scm.purchase_orders` has no agent column, so every PO sent `""` into `FK_PO_PurchaseAgent` |
| PO `CreditorCode` | 0 / 60 today | assigned DIRECTLY by `CreatePo`; a blank code is `FK_PO_Creditor` |

**The one finding whose prescribed fix would have fixed nothing** is
`SalesLocation`. The audit prescribed `mapOrPassthrough(x, LOCATION_MAP) ?? x`.
Re-measured at the moment of writing, that repairs **zero** orders: all 21
failures carry a BLANK `sales_location`, not an unmapped one, because
`deriveSalesLocationFromState` returns null for an order with no customer state.
Reading code would not have caught that; re-running the check did.

**Fix.**

- `mapOrPassthrough` **split**, not flipped, into `bookSpelling` (the book's own
  spelling or `null` = *never heard of it*) and `bookSpellingOrOwn` (else the
  ERP's value verbatim, for `/ensure-masters` to open). Flipping it would have
  broken `resolveAcAgent`, which must refuse an unmapped raw `agent` — that
  column holds bare uuids and "Unassigned" in production, and the service opens
  an agent under exactly the string it is given. Every caller was enumerated
  first.
- `soCustomerRef`, `soBranding`, `soInvoiceAddress`, `soSalesLocation` — one
  named function per field, each reading where the ERP actually keeps the value;
  five columns added to `SO_HEADER_COLS` and `branding` to `SO_ITEM_COLS`.
- **BRANDING is the one field that does NOT pass through, and production is what
  decided that.** The first version of this fix did pass it through; running the
  check against production printed the six values it would open as brands in the
  licensed book — `2990s Sofa` (44 orders), `Accessories` (8), `2990s Mattress`
  (8), `2990` (3), `Bedframe` (3), `Happi.S` (2). Four categories and a company
  name: `mfg_products.branding` is not a brand vocabulary, so `BRANDING_MAP`
  became an allow-list and the check prints that list every run. `CARRESS` and
  `DUNLOP` were ADDED to it instead — real brands in the book's own history that
  the map had simply never been told about, which is what a spelling map is for.
- The header `SalesLocation` falls back to the stock location the document's own
  LINES resolve to, which opens no master: `requireLocation` has already refused
  a line without one, so `mastersOf` is collecting that code off the line anyway.
  **This does not make the 21 writable** — the after-run says so plainly, and the
  report was extended to say why: 13 have no live line at all
  (`MissingSalesLocationError`) and 8 have lines with no `warehouse_id`
  (`MissingLocationError`, which already refused them). The gain is a named
  skipped row instead of a document lost to a foreign key, plus a pass-through
  that covers the unmapped case production does not exhibit today.
- Every PO names `AC_PURCHASE_AGENT` (`OTHERS`), and a supplier with no code is
  REFUSED (`MissingCreditorError`) rather than sent blank — the `MissingAgentError`
  precedent, applied twice more.
- `soEditHeader`'s own written rule — *"A NULL VALUE IS OMITTED, NEVER SENT"* —
  applied by construction: one `present()` helper at the single place a header
  is built, wrapping `soEditHeader`, all four `DOWNSTREAM[*].header` builders and
  the PO edit, with `AcDownstreamSpec.header` retyped `Record<string, string>` so
  a null cannot be put back without a compile error.
- `mastersOf` reads `body.Header` as well as the top level, in the SAME change —
  a pass-through that opens nothing on the edit path would have been the bug
  again one level down. Its sales/purchase discriminator now also reads
  `DocType`, because a PO edit carries no `CreditorCode` at all.
- `enqueueConvert` omits `Ref` / `DocDate` instead of sending null.
- `EnsureMasters`'s header comment claimed *"It never creates a LOCATION"* while
  the loop sixty lines below calls `SaveLocation`. The CODE was right — the
  owner asked for everything to be opened on 2026-08-11 and the module guide
  records it — so the COMMENT was corrected, and now carries what that costs:
  19 of 25 `scm.warehouses` codes are in neither the map nor the book.

**The master-opening consequence, in numbers, because it is a real one.** The
venue pass-through appends **3 options** to the book's 94-option VENUE dropdown
(`2990s PJ` ×110, `AEON BIG KEPONG` ×1, `AEON BIG PUCHONG` ×1) — reversible from
AutoCount's own UDF maintenance screen. It opens **0 new stock locations**: no
unpushed order carries an unmapped non-blank `sales_location`, and the header now
falls back to a code its own line already names. The 19-of-25 warehouse exposure
is on the LINE path, has been live since go-live, and this change does not widen
it.

**Why the check itself had to change too.** The report was still counting
AGENT_MAP hits after #2148 had taught the composer to pass an unmapped staff name
through, so it reported 96 unrescuable orders that the composer would in fact
have written — a checker measuring a design the code no longer had. Every
ERP-side section now calls the composer's own function and prints two numbers per
field: how many orders still send nothing, and which masters a pass-through would
OPEN, by name and count.

**Ref** — 2026-08-14, `fix/autocount-field-alignment`. No migration.
`docs/autocount-field-alignment-audit.md` carries the per-finding trace and what
is still open.

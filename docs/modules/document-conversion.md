# Module: Document conversion (SCM) — the full grid

> Written 2026-08-16 from a source read of `main` @ `dda30c19e`, after the owner
> asked: *"By right all my documents should be multi-selectable and convertible
> to the next document. Right now to convert to a Consignment Note I can only go
> INTO Consignment Notes and click 'Convert from'. Every place should have both
> 'Convert from' and 'Convert to' — that is how the work actually flows."*
>
> This guide is the MAP. It records what exists today and what does not. It
> proposes no build.

> **Line numbers are INDICATIVE.** Resolve a route to its current line with the
> generated artifact, which cannot go stale:
> `npm --prefix backend run gen:route-locator`.

> **THE BUTTONS WERE RENAMED ON 2026-08-17.** Every user-visible "Convert
> to X" / "Convert from X" is now **"Transfer to `<Document>`"** /
> **"Transfer from `<Document>`"**, generated from one table — the rule and the
> full label list are in **§9.6**, what changed is in **§9.8**.
>
> **§1–§8 below still use the OLD names**, deliberately: they are the dated
> record of the audit that produced the grid, and rewriting a dated finding makes
> it untrustworthy. Read "Convert to SI" in §2 as today's "Transfer to Sales
> Invoice". The abbreviations `CF` / `CT` still mean the destination-side and
> source-side entry point.

---

## 1. The shape of the system, in one paragraph

Every conversion in this ERP is built the same way: a **dedicated
"convert-from" PICKER PAGE that belongs to the DESTINATION document**. You reach
`/scm/purchase-orders/from-so` from the Purchase Order side; you reach
`/scm/consignment-notes/from-order` from the Consignment Note side. Ten such
pickers exist. Every one of them supports multi-select at LINE level, and eight
of the ten also let you draw lines from SEVERAL source documents at once.

So the owner's diagnosis is right, and it is broader than Consignment Notes:
**the system is destination-centric by construction.** "Convert from" is the
primary, complete, well-built mechanism. "Convert to" — starting on the source
document you are already looking at — is a thin, inconsistent layer of shortcuts
bolted on top, and most of those shortcuts do not actually carry the source
across (§4).

---

## 2. The conversion grid

`CF` = a "Convert from" entry point exists (on the destination).
`CT` = a "Convert to" entry point exists (on the source).
`Multi` = can you select MANY source documents/lines in one go?

| # | Source → Destination | CF | CT | Multi | Where CT lives | Gap size |
|---|---|:--:|:--:|---|---|---|
| 1 | **SO → PO** | yes | partial | **lines across many SOs** | PO detail in `?edit=1` only ("From Sales Order"); MRP page "Proceed PO (N)". **Nothing on the SO list or SO detail.** | **M** |
| 2 | **SO → DO** | yes | partial | **lines across many SOs** (picker); **true bulk** on the planning board | SO list row drawer "Deliver" (one SO, **now scoped** — §4a); Delivery Planning "Convert to DO" / "Convert {n} to DO" | **S** |
| 3 | **DO → SI** | yes | yes | **lines across many DOs** | DO detail + DO list drawer "Convert to SI" (one DO, **now scoped** — §4a) | **none** |
| 4 | **PO → GRN** | yes | **yes, fully** | **many PO lines; bulk from the PO list** | PO detail, PO list drawer, and PO list **bulk bar** — the only fully-working CT in the system | **none** |
| 5 | **GRN → PI** | yes | yes | lines, **ONE GRN** (PI carries a single `grn_id` FK) | GRN detail + GRN list "Convert to PI" (**now scoped** — §4a) | **none** |
| 6 | **GRN → PR** | **no** | yes | — | GRN detail + list "Convert to PR" — the param mismatch that opened it blank is **fixed** (§4a); there is still no `/from-grn` picker page | **S** |
| 7 | **DO → Delivery Return** | yes | **no** | lines across many DOs | — | **S** |
| 8 | **Consignment Order → Consignment Note** | yes | yes (whole-order only) | lines across many COs | CO list row menu + CO detail "Create Consignment Note" — prefills the WHOLE order, no line picking | **S** |
| 9 | **CN → Consignment Return** | yes | yes | lines across many CNs | CN detail "Create Consignment Return" | **none** |
| 10 | **PC Order → PC Receive** | yes | **no** | yes | — (deliberately dropped, see §5) | **S** |
| 11 | **PC Receive → PC Return** | yes | **no** | yes | — (deliberately dropped) | **S** |
| 12 | **Quotation → SO** | **no** | **no** | — | **does not exist at all** (§5) | **L** |
| 13 | SO → Consignment Note | **no** | **no** | — | deliberate: *"a consignment note is free-entry"* | n/a |

### What the grid says, plainly

- **FOUR pairs now have a complete, working "Convert to"**: PO → GRN, DO → SI,
  GRN → PI and SO → DO. It was ONE when this guide was written; the other three
  were repaired the same day (§4a). Everything else is *missing* the button
  rather than having a broken one.
- **Three pairs have no "Convert to" at all**: DO → Delivery Return, PC Order →
  PC Receive, PC Receive → PC Return.
- **One pair has no "Convert from"**: GRN → PR (there is no
  `/scm/purchase-returns/from-grn` picker page).
- **One pair does not exist in either direction**: Quotation → Sales Order.
- **Multi-select at LINE level is universal** in the ten pickers. What is NOT
  universal is multi-select of *source documents* from a list, which exists in
  exactly two places: the PO list's bulk "Convert to GRN", and the Delivery
  Planning board's bulk "Convert {n} to DO".

### The Sales Order list has multi-select, and it drives PRINT only

`frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx`. `selectedIds` is declared
under the comment *"Multi-select → batch 'Print all'"* and has exactly three
consumers: the toggle helpers, a PDF function, and the bulk bar — whose copy
reads *"Combine into one PDF or download separately."* and whose only button is
`Print all (N)`. The set is also handed to `DataTable selection`.

**No convert action is wired to it.** The only SO → X action on the page is the
single-row drawer button "Deliver". Bulk SO → DO lives only on the Delivery
Planning board; bulk SO → PO only on the MRP page. This is exactly the owner's
complaint, and it is confirmed.

---

## 3. Consignment Notes specifically — the owner's example

**Confirmed, with one correction.**

`frontend/src/pages/scm-v2/ConsignmentNotes.tsx`'s own header says it outright:

> *"The DO-specific 'From Sales Order' toolbar button and the SI / DR convert
> menu entries are intentionally DROPPED — a consignment note is free-entry."*

The CN list has only `New Consignment Note`, and its row menu is
Edit / View / Cancel / Reopen. So the line-level picker
(`ConsignmentNoteFromOrder.tsx`) is reachable **only** by entering the
Consignment Note screen: New Consignment Note → "From Consignment Order".

**The correction:** there IS a source-side path the owner may not have counted.
`Create Consignment Note` exists in the **Consignment Orders list row context
menu** and on the **Consignment Order detail**. Both prefill the whole order
into the New CN form via `?fromConsignmentOrder=`, and that parameter IS read.
What it does not offer is line-level picking — it is all-or-nothing.

So: *the line picker* is CN-screen-only, exactly as reported; *a whole-order
convert* does exist from the Consignment Order side.

---

## 4. The defect that makes most "Convert to" buttons cosmetic

**Eight of the ten picker pages never read their URL parameters.** Verified by
counting `useSearchParams` / `useLocation` / `useParams` in each file:

| Picker | param hooks |
|---|---|
| `PurchaseOrderFromSo.tsx` | 3 — reads `?poId` |
| `GrnFromPo.tsx` | 17 — reads `?poId`, `?appendToGrn` |
| `PurchaseInvoiceFromGrn.tsx` | **0** |
| `SalesInvoiceFromDo.tsx` | **0** |
| `DeliveryOrderFromSo.tsx` | **0** |
| `DeliveryReturnFromDo.tsx` | **0** |
| `ConsignmentNoteFromOrder.tsx` | **0** |
| `ConsignmentReturnFromNote.tsx` | **0** |
| `PurchaseConsignmentReceiveFromOrder.tsx` | **0** |
| `PurchaseConsignmentReturnFromReceive.tsx` | **0** |

Consequence: the source-side buttons that navigate with a scope parameter —
`Convert to PI` (`?grn=`), `Convert to SI` (`?do=`), `Deliver` (`?so=`) — all
drop the operator into the **global, unscoped picker**. The operator is looking
at one document, presses "convert this", and is handed a list of everything.
The parameter is constructed, appended and discarded.

**A second, separate defect on the same path — GRN → PR.** The GRN list and
detail both navigate to `/scm/purchase-returns/new?fromGrn=<id>`, while
`PurchaseReturnNew.tsx` reads `params.get('grnId')`. The names do not match, so
`Convert to PR` always opens a blank free-form Purchase Return with no GRN
attached.

**A third — a dead route.** `SalesInvoicesListV2.tsx`'s `goFromSo` navigates to
`/scm/sales-invoices/from-so` under the label "New from Sales Order". No such
route is registered in `App.tsx` (only `/new`, `/from-do`, `/:id`), so it falls
through to the detail route with `id="from-so"`.

**A fourth — a mislabel.** The SO list's "New from quotation" routes to
`/scm/sales-orders/new/guided`, which is the sofa configurator and references no
quotation anywhere.

> **Three of these four are now FIXED** — see §4a, which also records what the
> repair enumerated and what it deliberately left. The FOURTH (the "New from
> quotation" mislabel) is still open: it is a copy decision, not a broken link.
>
> Two corrections to the table above, from re-deriving it on 2026-08-16: the
> hook counts differ if you count `params.get(...)` as well (`GrnFromPo` reads
> 17 by that measure, 2 by this one), and the binary fact is what matters —
> eight read ZERO. And **only THREE of those eight were receiving a parameter**;
> the other five have no "Convert to" button pointing at them, so they had
> nothing to drop. "Reads no parameter" and "is broken" are not the same claim.

---

## 4a. The link contract — how a "Convert to" says where it came from

*Added 2026-08-16 with the repair of the first three defects in §4.*

Every call site used to spell the scope parameter itself, which is why neither a
DROPPED parameter nor a MISSPELT one could fail anywhere: not at compile time,
not in a test, and not on screen. **`frontend/src/lib/convertScope.tsx` now
names each conversion's parameter ONCE**, keyed by pair, and both sides import
it:

| side | what it calls |
|---|---|
| the source button | `convertToLink(pair, keys)` → the URL |
| the destination picker | `readConvertScope(pair, searchParams, alsoKnown)` → `{ keys, unknown }` |
| the destination picker | `<UnrecognisedScopeNotice unknown={scope.unknown} />` |

| pair key | source-side button | destination | parameter |
|---|---|---|---|
| `poToGrn` | PO detail, PO list row, PO list **bulk bar** | `GrnFromPo` | `poId` |
| `grnToPi` | GRN detail, GRN list row | `PurchaseInvoiceFromGrn` | `grnId` |
| `grnToPr` | GRN detail, GRN list row | `PurchaseReturnNew` | `grnId` |
| `poToPr` | PO detail "Raise Return" | `PurchaseReturnNew` | `poId` |
| `doToSi` | DO detail, DO list row | `SalesInvoiceFromDo` | `doId` |
| `soToDo` | SO list row "Deliver" | `DeliveryOrderFromSo` | `soDocNo` |

The rules, taken from `GrnFromPo` — the one convert that already worked:

- **The parameter is named for what it CARRIES.** `soDocNo`, not `soId`: that
  picker's rows come from `/delivery-orders-mfg/deliverable-so-lines`, which
  returns `docNo` and no order id. A parameter called `…Id` holding a document
  number is the same drift wearing a different hat.
- **One or many.** The value is a comma-separated list, so single convert and
  the PO list's bulk "Convert to GRN" use the same parameter and a picker that
  reads it gets multi-source for free.
- **No parameter means the FULL picker** — a legitimate entry point (the list
  toolbars' "From PO" / "From Delivery Order"), not a broken link.
- **A scoped picker filters AND pre-ticks** the source's remaining lines at full
  quantity, and offers a "Show all …" escape. Nothing is created: Continue only
  carries the picks to the New-document form.
- **A scoped picker's EMPTY state says the SCOPED thing is empty.** "Nothing
  left to invoice on the Delivery Order you came from" and "no invoiceable lines
  exist anywhere" are opposite facts, and the operator acts on the second one by
  walking away from work that is still outstanding.
- **An unrecognised parameter is SHOWN, never dropped.** That silence is exactly
  what let `?fromGrn=` live: the screen looked like an ordinary blank form.
- **`alsoKnown` is REQUIRED, never optional**, per CLAUDE.md's rule about a
  parameter that decides something — it decides whether a name counts as
  unrecognised, and an optional one gets forgotten into "off" one screen at a
  time. Pass `[]` when the screen takes nothing else.

### `appendTo…` is the opposite direction, deliberately outside the table

`/scm/grns/from-po?appendToGrn=<id>` and `/scm/purchase-orders/from-so?poId=<id>`
name an existing **destination** document to append the picked lines INTO.
Mixing that with a source scope in one table is how the next reader gets it
backwards, so those stay hand-written and are declared via `alsoKnown`.

### What enforces it

- `frontend/src/lib/convertScope.test.tsx` — the contract, **plus a tree scan
  that fails on any site hand-writing a query onto a convert path.** A
  convention people must remember is what failed here, so the check is the
  memory.
- `frontend/src/pages/scm-v2/convert-scope-pickers.test.tsx` — mounts each
  repaired picker under a real router at the real URL its real caller builds and
  asserts the operator sees the document they came from, not the one beside it.

### What the repair deliberately left

- **The five pickers that read no scope and receive none**
  (`DeliveryReturnFromDo`, `ConsignmentNoteFromOrder`,
  `ConsignmentReturnFromNote`, `PurchaseConsignmentReceiveFromOrder`,
  `PurchaseConsignmentReturnFromReceive`) — no button points at them, so there
  is nothing to scope to. Adding the button is the §8 decision, not a repair;
  when one is added it costs one `convertToLink` and one `readConvertScope`.
- **The "New from quotation" mislabel** (§4, defect four) — a copy decision.
- Everything in §8 — those are builds the owner has not chosen.

### There is no Sales Order → Sales Invoice conversion

§4's third defect is fixed by **removing** the button, not by repointing it. The
only SI converter the backend exposes is `POST /sales-invoices/from-dos`, fed by
`GET /sales-invoices/invoiceable-do-lines`; a Sales Invoice is built from
DELIVERY ORDERS. SO → SI does not exist in this system in either direction, so
there was nothing for `/scm/sales-invoices/from-so` to point at.

---

## 5. Documents with no conversion entry point, and whether that is deliberate

| Document | State | Deliberate? |
|---|---|---|
| **Quotation (QT)** | `backend/src/scm/routes/quotes.ts` has `GET /`, `POST /`, `PATCH /:id`, `PATCH /:id/cancel` and **no frontend consumer at all**. There is no QT → SO conversion anywhere in this codebase. | UNKNOWN — nothing in the source says. This is the one genuinely absent lifecycle step. |
| **Purchase Consignment Order / Receive** | The "From Sales Order" button, the MRP shortage picker and the multi-select "Convert to GRN" batch flow were all removed; so were the From-PO button and the right-click "Convert to PI / PR". | **Yes** — both files' headers say so explicitly. |
| **Stock Take** | Post writes adjustment *movements*, not a document. | Yes — not a conversion. |
| **Payment Voucher** | Has an "Apply to PI" allocation picker. That is an allocation, not a convert. | Yes. |
| **Credit Note** | Not a document type here at all — it is a status (`CREDIT_NOTED`) and a `credit_note_ref` field on returns. | Yes. |

---

## 6. Mobile

`frontend/src/mobile/MobileConvertWizard.tsx` is a single wizard covering FOUR
pairs, and it is **entirely destination-centric** — its own screen title is
"Convert to {target}" and its sub-line is "Convert from a {source}". Pressing
`+ New` on a module list opens it:

| Module list | Wizard target | Source | Multi-select |
|---|---|---|---|
| Delivery Orders | DO | SO | ONE source at a time |
| Sales Invoices | SI | DO | ONE source at a time |
| Goods Receipts | GRN | PO | **many POs, one supplier** |
| Purchase Orders | PO | SO | ONE source at a time |

It reads the SAME per-line "remaining" endpoints the desktop pickers use, so the
two surfaces cannot disagree about what is convertible — including
`/mfg-purchase-orders/outstanding-so-items`, which means **mobile SO → PO
inherits the MRP truncation described in `docs/modules/purchase-order.md`.**

Also mobile: `MobileDeliveryPlanning.tsx` offers `Create DO` on a stop that has
no DO yet (one SO).

**Desktop-only pairs** (no mobile equivalent): GRN → PI, GRN → PR, DO → DR, all
four consignment pairs, all four purchase-consignment pairs, the Delivery
Planning bulk convert, and MRP → PO. **Mobile-only pairs: none.**

---

## 7. Backend converters with no live frontend caller

Worth knowing before building anything: several converters already exist
server-side and nothing calls them. A "Convert to" that needs one of these may
not need a new endpoint.

- `POST /mfg-purchase-orders/:id/convert-from-so` — hook `useConvertPoFromSo`
  has zero consumers.
- `POST /sales-invoices/:id/items/from-do/:doId` — hook
  `useAppendDoToSalesInvoice` has zero consumers.
- `POST /purchase-consignment-receives/from-pcos`,
  `POST /purchase-consignment-returns/from-pc-receives`,
  `POST /purchase-consignment-returns/from-pc-receive` — no frontend caller.
- Unused hooks: `useGrnFromPos`, `usePurchaseReturnFromGrns`,
  `usePurchaseInvoiceFromGrn`, `usePurchaseReturnFromGrn`,
  `useConvertDoToDeliveryReturn`, `useConvertDosToSi`,
  `useCreateGrnsFromPoItems`, `useCreatePisFromGrnItems`.

---

## 8. Sizing the gaps, for the owner to choose from

Sizes are relative build cost, not priority.

| Gap | Size | Why |
|---|---|---|
| Make the eight pickers read their scope param | **S** | One `useSearchParams` + one filter per file. It turns four existing buttons from cosmetic into working, and it is the cheapest visible win here. |
| Fix `fromGrn` / `grnId`, the dead `from-so` route, the "New from quotation" label | **S** | Three one-line corrections. |
| Add "Convert to" on the DO → DR, PC Order → PC Receive, PC Receive → PC Return pairs | **S** each | The pickers already exist; this is a menu entry plus the scope param above. |
| Bulk "Convert to DO" / "Convert to PO" on the **SO list** | **M** | The multi-select machinery is already on the list; it needs a second bulk action and a route into the picker with N doc numbers. The PO list's bulk "Convert to GRN" is the working precedent to copy. |
| Line-level "Convert to CN" from the Consignment Order list | **S** | Whole-order convert already exists; this is the line-picker variant. |
| Quotation → Sales Order | **L** | No UI for quotations at all. A new surface, not a conversion. |
| A uniform convert layer (every list gets both directions from one component) | **L** | The correct end state the owner is describing, and the only one that stops this grid drifting again. |

---

## 9. Vocabulary — is it "Convert to/from" or "Transfer to/from"?

> Added 2026-08-17, for the owner's question: *"I want a system-wide audit — are
> the words 'transfer to' and 'transfer from' used consistently? Or is it
> 'convert to' / 'convert from'? I think unifying everything to transfer from /
> transfer to would be better, wouldn't it?"*
>
> **The owner approved the naming rule on 2026-08-17 and STAGE 1 HAS SHIPPED.**
> §9.1–§9.5 are the audit that sized the work; §9.6 is the approved rule and the
> staging; §9.8 records exactly what Stage 1 changed and what it deliberately did
> not. Read with `docs/transfer-from-to-vocabulary.md`, which surveys the LINEAGE
> COLUMNS from the same question a few hours earlier — this section is the layered
> rename-cost view that survey does not carry, and it **corrects three liveness
> claims in it** (§9.7).

### 9.1 The answer, before the inventory

**The owner's instinct is right, and the reason is stronger than consistency:
"transfer" is the word the accounting book already uses for this operation, and
"convert" is the ERP's own invention.**

Three independent layers already say "transfer", and they were not coordinated:

| layer | evidence | word |
|---|---|---|
| the AutoCount SDK | `TransferFrom` is a **first-class SDK type**; the primitives are `SalesDocument.FullTransfer(String[], TransferFrom, …)` and `PartialTransfer(TransferFrom, …)`, plus `IsTransferFromSupported()` / `IsFullTransfered()` / `TransferFromToDocumentType(TransferFrom)`. Dumped by reflection off the installed 2.2 assemblies and recorded in `backend/scripts/autocount-service/AcSyncService.cs` + `sdk-api-reference.txt`. | **transfer** |
| the data layer | `sales_orders.transfer_to`, fed from `o.TransferTo` in `backend/src/services/acSnapshot.ts`; `backend/src/services/assr.ts` calls it *"AutoCount's own SO → DO transfer chain"* and uses it as the EXACT SO→DO linkage | **transfer** |
| the UI, in part | **nine live screens** already label document lineage **"Transfer From (SO)"**, **"Transfer To (DO)"**, **"Transfer From (Order)"**, **"Transfer From (Receive)"**, **"Transfer To:"**, **"Transfer To (GRN)"** — six routed straight from `App.tsx`, three reached through the `?edit=1` forward (§9.7). See §9.4 layer A | **transfer** |

So the proposal does **not** introduce a new word. It picks the word that
AutoCount, the mirror columns and roughly half the UI already use, and retires
the one the ERP invented. That is a much easier decision than a taste call.

**One precondition, and it is a real blocker for a blind rename.** The word is
currently OCCUPIED on one live screen by a different meaning — see §9.3. Free
that first, or the unification creates the ambiguity it is meant to remove.

### 9.2 Does `transfer_to` mean the same thing as "Convert to"? — YES for the mirror, NO for the ERP's own column

This was the load-bearing question. It resolves into **four different things
wearing one name**, and they must not be treated alike:

| the thing | what it holds | same concept as "Convert to"? |
|---|---|---|
| `sales_orders.transfer_to` (the AutoCount **mirror** table) and `ac_snapshot_sales_orders.transfer_to` | the DO document number this SO became, straight from AutoCount's `TransferTo`. `assr.ts` reads it as the SO→DO linkage and filters `XS`-prefixed values as *"AutoCount's cancelled-transfer artifacts"* | **YES — exactly.** It is the NOUN (the document produced) for the same relationship "Convert to DO" is the VERB of. Unifying is clean. |
| `mfg_sales_orders.transfer_to` (**the ERP's own** SO table) | free text. Written at create from `body.transferTo`, patchable, selected into the header payload — and **no live frontend reader**: `git grep -n "\.transfer_to\b" -- frontend/src` returns nothing, and the only frontend occurrence is a type field | **NO — it holds nothing.** A dead column whose name already claims the word. |
| `transfer_to_grns` | a **derived** forward PO → GRN list, reverse-scanned from `grns.purchase_order_id` in `mfg-purchase-orders.ts`. An API response field, not a column | yes in meaning, but it is computed per request |
| `inventory_movement_type = 'TRANSFER'` | stock moved between warehouses | **NO — different concept entirely.** §9.3 |

**PROVEN — the semantic is document lineage, not a branch or stock movement.**
AutoCount's transfer family is the document-conversion family: its members are
`SO→DO`, `PO→GR`, `DO→IV`, `GR→PI`, and the ERP's outbox ops are named for
exactly those pairs (`so_to_do`, `po_to_gr`, `do_to_iv`, `gr_to_pi`). Nothing in
the SDK dump ties `TransferTo` to a warehouse or an inter-company hand-off.
**The recommendation does not flip.**

### 9.3 Is a THIRD concept already using "transfer"? — Yes, stock movement. It collides in exactly ONE place, and that place is live.

Stock Transfer is a real document type here (`scm.stock_transfers`,
`/scm/stock-transfers`, `fn_stock_transfer_apply`). **At the phrase level it
mostly does NOT collide**, because it words itself differently:

| stock movement says | document lineage says |
|---|---|
| "New Stock Transfer", "Post Transfer", "Transfer Date", "Total Transfers" — *transfer as a NOUN, the document* | "Transfer From (SO)", "Transfer To (DO)" — *always with the source/target document type in parentheses* |
| **"From Warehouse" / "To Warehouse"** for the endpoints — columns `from_warehouse_id` / `to_warehouse_id` | never mentions a warehouse |
| `'Transfer to warehouse ' \|\| …` in mig 0192's audit note, and `consignment-loaner.ts`'s "transfer to warehouse N" — *always qualified by the word warehouse* | — |

So the two senses are separated by grammar, and the owner's proposal is
compatible with both. **Except once:**

> **`frontend/src/pages/scm-v2/PurchaseOrderDetailV2.tsx` renders a PO line
> column keyed `transferTo` and labelled `"Transfer to"` whose value is
> `warehouseNameById.get(l.warehouse_id)` — the destination WAREHOUSE.**

That screen is the read-only PO detail at `/scm/purchase-orders/:id` — the
default view, the most-seen PO surface. And one click away, the SAME route with
`?edit=1` forwards to `PurchaseOrderDetail.tsx`, which heads a table
**"Transfer To (GRN)"** meaning the downstream GRN. **So the PO module already
shows the operator both meanings of "Transfer to", on one document, one click
apart.** This is not a hypothetical collision introduced by the rename; it is
live on `main` today, and it is the one thing that must be fixed BEFORE a
unification rather than after. See §9.7.

### 9.4 The inventory, by layer

Counts are **matching LINES** from `git grep -ci` over `backend/src` +
`frontend/src` at `6bf96a954` (2026-08-17). Re-run the commands rather than
trusting the numbers:

```
Convert to      52 lines / 31 files          convertTo      73 / 13
Convert from    16 lines /  9 files          convertFrom     0 /  0
Transfer to     14 lines / 11 files          transferTo      7 /  5
Transfer from   24 lines / 18 files          transferFrom    0 /  0
                                             transfer_to    30 / 17
                                             transfer_from   0 /  0
```

`convertFrom`, `transferFrom` and `transfer_from` are at **zero** — the "from"
direction has never been an identifier anywhere. Every "from" link in this
system is stored as a source FK (`so_doc_no`, `grn_id`, …) and named for the
document, which is why there is nothing to rename on that side.

| # | Layer | What is in it | Rename cost | Verdict |
|---|---|---|---|---|
| **A** | **user-visible copy** | ~16 "Convert to/from …" strings (11 desktop buttons/menu items, 4 mobile wizard titles, 1 mobile sub-line) plus the Delivery Planning toast/confirm family ("Convert failed", "Convert N sales orders to delivery orders?", "Converted N …", "Converting…", "Convert N to DO"), `ConsignmentOrders`' "Nothing to be converted", and `DeliveryOrderNewV2`'s **"⇄ Converted from"** provenance badge. Against them, **10 lineage label sites across the 9 live screens** already saying "Transfer From/To" (the 11th match, `PurchaseOrderDetailV2`'s, is the warehouse outlier of §9.3; a 12th is a comment in `ConsignmentReturns.tsx` recording a column that was deliberately dropped). | **S** — string literals + their tests | **DO IT.** All of the value, none of the risk. |
| **B** | **route paths / URL segments** | **NOTHING TO RENAME.** No SPA route carries a `convert` segment, and the only routes carrying `transfer` are the three stock-transfer ones. The pickers are already named for the *direction and source*: `/from-so`, `/from-po`, `/from-grn`, `/from-do`, `/from-note`, `/from-order`, `/from-receive`, `/from-pc-order`. One backend endpoint carries the word: `POST /mfg-purchase-orders/:id/convert-from-so` — and §7 records it has **zero frontend callers**. | **zero** | **SKIP.** No bookmark breaks, no redirects needed. |
| **C** | **query-string parameter names** | `convertScope.tsx` standardises on `poId`, `grnId`, `doId`, `soDocNo` — every one names the SOURCE DOCUMENT, not the operation. The vocabulary question does not reach this layer. | **zero** | **SKIP.** Already neutral. |
| **D** | **TypeScript identifiers / component + file names** | `convertToLink` (42), `enqueueConvert` (42), `recordConvertSkipped` (27), `readConvertScope` (21), `convertScope` (20), `MobileConvertWizard` (15), `confirmOverConvert` (13), `soLineOverConvertRefusal` (12), `findOverConvertOffender` (12), `CONVERT_LINKS`, `ConvertTarget`, `convertTitle`, `PoConvertContext`, … plus `convertScope.tsx` / `MobileConvertWizard.tsx` / `convert-scope-pickers.test.tsx` as filenames | **M** — mechanical but a large, noisy diff across the money routes and the outbox | **LATER, or never.** Internal-only. Buys consistency for readers, not for the owner. |
| **E** | **API response fields** | `converted_po_nos` (assembled in `mfg-sales-orders.ts`, read by `soPoChips.ts`, `SoSourceChips.tsx`, `MobileSalesOrders.tsx`, `MfgSalesOrdersListV2.tsx`, `mobile/source-chips.tsx`) and `transfer_to_grns`. Neither is a column. | **M** — must land backend + desktop + mobile in ONE PR or a list silently renders empty | **LATER.** Real breakage risk for no user-visible gain. |
| **F** | **database columns** | `sales_orders.transfer_to`, `ac_snapshot_sales_orders.transfer_to`, `mfg_sales_orders.transfer_to`, `consignment` `transfer_to`. **Already the owner's preferred word** — there is nothing to rename TOWARDS "transfer". | **zero** | **SKIP — already correct.** The one open question is whether to DROP the dead `mfg_sales_orders.transfer_to`; that is a separate decision, not a rename. |
| **G** | **AutoCount-facing field names** | `TransferTo`, `TransferFrom`, `FromDocNo`, `FromDocType`, `FromSODtlKey`, `FullTransferFromDocList` | **not ours** | **NEVER.** Confirmed: these are AutoCount's own SDK and schema names, read by reflection against `AutoCount.Sales.dll`. Renaming them breaks the write-back. |

### 9.5 Three false-positive classes a blind `sed` would corrupt

"Convert" is also the correct English word for three unrelated operations in
this tree. A tree-wide replace would silently damage all three:

1. **Unit / currency / date conversion.** `scan-so.ts` — *"convert to
   YYYY-MM-DD"*; `assistant.ts` — *"convert to RM when you state them"*;
   `fabric-tier-addon.ts` — *"convert to the order's unit"*.
2. **"Fabric Converter"** — a live product tool (`FabricTracking.tsx`,
   `Products.tsx`), and the `scm.fabric_trackings` indexes built for it. Not a
   document conversion at all.
3. **Agent governance** — `governance.ts`'s `neverAutonomous: 'Convert to firm
   order'`, about a demand signal, not a document.

Also: `SupplierDetail.tsx`'s *"a follow-up to convert to a single request"* is a
refactor note about code.

### 9.6 The approved rule (owner, 2026-08-17)

**Two sentences generate every transfer label, and nothing else does.** They live
in `frontend/src/lib/convertScope.tsx` as `transferToLabel()` /
`transferFromLabel()` over one `TRANSFER_DOC` table — not as string literals,
because twenty hand-written literals is exactly how desktop came to say "Convert
to GRN" while mobile said "Convert to Goods Receipt" for one operation:

```
Transfer from <Source document, full name>        secondary · header action row
Transfer to   <Destination document, full name>   primary   · footer action bar
```

Three properties, each of which was a real defect before:

- **Full document names. Abbreviations never appear on a button** — `SI`, `PI`,
  `PR`, `GRN`, `DO`, `SO` stay in document NUMBERS, where an abbreviation
  actually identifies something.
- **Always SINGULAR.** The button names the source *type*, not the count.
  Picking ten sales orders still reads "Transfer from Sales Order". The old
  plural ("one or more Purchase Orders") described the widget.
- **`Deliver` and `Mark signed` leave the primary slot together.** `Deliver`
  becomes "Transfer to Delivery Order" — it names the document produced, not the
  physical act. `Mark signed` is NOT a transfer (it changes that document's own
  status), so it stays *secondary* beside Edit and Print and the primary slot
  goes to the transfer. This is what the owner spotted: the sales order reported
  a `Delivered` STATUS while the delivery order offered a `Mark signed` ACTION.
  **Statuses report; buttons act.**

#### The 20 labels

| flow | on the source (primary, footer) | on the destination (secondary, header) |
|---|---|---|
| Sales Order → Delivery Order | Transfer to Delivery Order | Transfer from Sales Order |
| Sales Order → Purchase Order | Transfer to Purchase Order | Transfer from Sales Order |
| Delivery Order → Sales Invoice | Transfer to Sales Invoice | Transfer from Delivery Order |
| Delivery Order → Delivery Return | Transfer to Delivery Return | Transfer from Delivery Order |
| Purchase Order → Goods Received | Transfer to Goods Received | Transfer from Purchase Order |
| Goods Received → Purchase Invoice | Transfer to Purchase Invoice | Transfer from Goods Received |
| Goods Received → Purchase Return | Transfer to Purchase Return | Transfer from Goods Received |
| Consignment Order → Consignment Note | Transfer to Consignment Note | Transfer from Consignment Order |
| Consignment Note → Consignment Return | Transfer to Consignment Return | Transfer from Consignment Note |
| Purchase Consignment Order → Receive | Transfer to Consignment Receive | Transfer from Consignment Order |

An 11th pair exists in the code and is NOT in the approved twenty: **Purchase
Order → Purchase Return** (`poToPr`, the PO detail's "Raise Return"). It is
labelled by the same rule — "Transfer to Purchase Return" — and named in
`TRANSFER_FLOWS` so it cannot drift; flag it if the owner wants it worded
differently.

#### Staging

| stage | scope | state |
|---|---|---|
| **0** | free the word — the PO line column that meant a warehouse (§9.3) | **SHIPPED** with Stage 1; it is the `BUG-HISTORY.md` entry |
| **1** | user-visible copy: buttons, titles, toasts, confirms, empty states | **SHIPPED** — see §9.8 |
| **2** | code identifiers — `convertTo…` → `transferTo…` (Layer D) | not started; internal, mechanical, noisy diff |
| **3** | route paths, only with redirects (Layer B) | **likely a no-op** — no SPA route carries a `convert` segment, and the pickers already read `from-so` / `from-po` / `from-grn` / `from-do`. The only endpoint carrying the word is `POST /mfg-purchase-orders/:id/convert-from-so`, which §7 records has zero frontend callers |

#### Do NOT touch, and say so in every PR

- **`transfer_to` (the database column)** — already the target name. Renaming it
  is a migration plus a write-back contract change for no gain (Layer F).
- **AutoCount's `TransferTo` / `TransferFrom`** — not ours, and already correct
  (Layer G). They are read by reflection against `AutoCount.Sales.dll`.

Both are listed here so nobody "finishes the job" later by renaming them.

#### Six of the twenty have no button to relabel

Named so the next person adds them with the right label; **this is feature work
the owner has not commissioned, and Stage 1 did not build any of it.** From §2:

| missing | which half |
|---|---|
| Delivery Order → Delivery Return | no "Transfer to" on the DO |
| Purchase Consignment Order → Receive | no "Transfer to" on the order |
| Purchase Consignment Receive → Return | no "Transfer to" on the receive |
| Goods Received → Purchase Return | no "Transfer from" picker page (`/scm/purchase-returns/from-grn` does not exist) |
| Sales Order → Purchase Order | no "Transfer to" on the SO list or SO detail — only PO-side `?edit=1` and the MRP page |
| Sales Order → Delivery Order (bulk) | exists only on the Delivery Planning board, not on the SO list |

### 9.7 Found while auditing — one fixed here, two doc corrections

1. **`PurchaseOrderDetailV2`'s "Transfer to" column shows a warehouse** (§9.3).
   A label using the document-lineage vocabulary for a warehouse, on the default
   PO screen, one `?edit=1` away from a "Transfer To (GRN)" that means the
   downstream document. Genuine live ambiguity; Stage 0 above.

2. **`docs/transfer-from-to-vocabulary.md` calls three live files dead.** Its
   §5(b) says *"Two dead files still carry the phrase and neither is imported:
   `GoodsReceivedDetail.tsx` … and `SalesOrderDetail.tsx`"*, and its §4(a) says
   `SalesOrderDetail.tsx` is a file *"which nothing imports (`App.tsx` routes the
   `*V2` twin)"*. **All three V1 detail pages are LIVE**, lazily imported by
   their own V2 twins and rendered whenever `?edit=1` lands on the route — the
   inline editors the Edit button opens:

   | V1 file | mounted by | reached at |
   |---|---|---|
   | `SalesOrderDetail.tsx` | `SalesOrderDetailV2.tsx` | `/scm/sales-orders/:id?edit=1` |
   | `GoodsReceivedDetail.tsx` | `GoodsReceivedDetailV2.tsx` | `/scm/grns/:id?edit=1` |
   | `PurchaseOrderDetail.tsx` | `PurchaseOrderDetailV2.tsx` | `/scm/purchase-orders/:id?edit=1` |

   The grep behind the "dead" claim looked at `App.tsx` routing only and could
   not see a lazy `import()` inside a sibling page — CLAUDE.md's *"a checker
   that cannot match reports a clean run"*. It matters here because it moves
   three "Transfer To" labels from *exempt dead code* into *in-scope live copy*,
   and because `SalesOrderDetail`'s "Transfer To" column is one an operator sees
   on every SO edit. **Corrected in that file by this PR** — text only.
### 9.8 What Stage 1 actually changed

The measurable assertion, which is in the PR as an `enumeration` block:
`git grep -c "Convert to\|Convert from" -- frontend/src` returns **nothing** (exit 1).

**Changed — 33 files under `frontend/src`.** Every label now comes from the generator, so the words
exist in exactly one place:

- **Source-side (primary):** GRN detail ×3 and GRN list ×2 → "Transfer to
  Purchase Invoice" / "Transfer to Purchase Return"; PO detail ×2 and PO list →
  "Transfer to Goods Received"; DO detail and DO list → "Transfer to Sales
  Invoice"; the SO list's `Deliver` and Delivery Planning's row action + bulk bar
  → "Transfer to Delivery Order"; the mobile wizard's four screen titles.
- **Destination-side (secondary):** the six list toolbars ("Transfer from
  Purchase Order / GRN / Sales Order ×2 / Delivery Order ×2") and the seven
  New-form pickers (Consignment Note, Consignment Return, Delivery Return ×2,
  PC Receive, PC Return, Purchase Invoice, Sales Invoice), plus the mobile
  wizard's sub-line — which also **lost its plural**.
- **Toasts, confirms and pending states** on Delivery Planning: "Transfer
  complete" / "Nothing transferred" / "Transfer failed" / "Transferring…" /
  "Transfer N sales orders to Delivery Order?".
- **`DeliveryOrderDetailV2`'s transfer became `variant="primary"`** and
  `Mark signed` stayed secondary, per the rule above.

**Deliberately NOT changed, and each for a reason:**

1. **`From SOs:` — it is not a label, it is a stored data contract.** The spec
   asked for it to go. It cannot go in a copy PR: `mfg-purchase-orders.ts` WRITES
   `` notes: `From SOs: ${docNos.join(', ')}` `` into `purchase_orders.notes` at
   raise time, and **three** regexes parse it back
   (`/^\s*From SOs?:\s*(.+)$/im` in `backend/src/scm/routes/document-flow.ts`,
   `frontend/src/pages/scm-v2/po-relationship-map.ts` and
   `frontend/src/vendor/scm/lib/purchase-order-pdf.ts`). For POs with no per-line
   `so_item_id` it is the **only** SO→PO linkage there is, so rewording it
   silently drops that provenance from the Relationship Map, `po-so-coverage` and
   the PO PDF for every row already in production. The parser already tolerates
   `From SO:` as well as `From SOs:`, so a singular WRITER is safe — but that is
   a data-format decision with a backfill question attached, not copy. **Left for
   the owner to rule on.**
2. **Provenance COLUMNS and detail fields** — "From SO", "From DO", "From PO",
   "From GRN" on the lists, and the nine screens already reading "Transfer From
   (SO)" / "Transfer To (DO)". These display a document NUMBER, which the rule
   explicitly leaves abbreviated, and the parenthetical is what keeps them
   unambiguous against Stock Transfer. Renaming ~15 column headers is a wider
   copy change than the approved twenty; §5(a) of the sibling survey ("one
   column, four labels") is the real defect there and is still open.
3. **Column `key`s**, including `PurchaseOrderDetailV2`'s `transferTo` —
   `DataTable` persists visibility, order and width per `tableId` in
   localStorage, so renaming a key silently resets operators' saved layouts.
   Stage 2 material, with a migration for the stored keys.
4. **`backend/src/scm/routes/grns.ts` and the picker guards / empty-state
   messages** — owned by the agent fixing transfer BEHAVIOUR concurrently. Where
   an empty state is both wrongly worded AND factually wrong (the "every line has
   been received" message), it is theirs, not this PR's.
5. **The `convertScope.tsx` / `MobileConvertWizard.tsx` filenames and every
   `convertTo…` identifier** — Stage 2.

**Three senses of "convert" were left alone on purpose** (§9.5): unit/currency/
date conversion, the "Fabric Converter" tool, and `governance.ts`'s "Convert to
firm order". A tree-wide replace would have corrupted all three.


---

## See also

- `docs/transfer-from-to-vocabulary.md` — the lineage-column survey and its
  three rename options; §9 above is the layered cost view and corrects its
  liveness claims
- `docs/modules/sales-order.md` §0 — every status on an SO and what moves it
- `docs/modules/purchase-order.md` — the SO → PO eligibility chain, and why a
  line silently vanishes from the From-SO picker
- `docs/modules/mrp.md` §5 — the demand-read truncation that gates that picker
- `docs/modules/document-traceability.md` — what the converted link means
  afterwards

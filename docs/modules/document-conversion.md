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

## See also

- `docs/modules/sales-order.md` §0 — every status on an SO and what moves it
- `docs/modules/purchase-order.md` — the SO → PO eligibility chain, and why a
  line silently vanishes from the From-SO picker
- `docs/modules/mrp.md` §5 — the demand-read truncation that gates that picker
- `docs/modules/document-traceability.md` — what the converted link means
  afterwards

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

## See also — for §1–§8, the ENTRY POINTS

- `docs/modules/sales-order.md` §0 — every status on an SO and what moves it
- `docs/modules/purchase-order.md` — the SO → PO eligibility chain, and why a
  line silently vanishes from the From-SO picker
- `docs/modules/mrp.md` §5 — the demand-read truncation that gates that picker
- `docs/modules/document-traceability.md` — what the converted link means
  afterwards

**§9 below is a different question.** Everything above is about which screens
offer a conversion. §9 is about the model underneath — what stops the same goods
being transferred twice — and carries its own comparison against SAP, NetSuite,
Odoo, Business Central and AutoCount.

---

# 9. The transfer MODEL — what records that a line has been consumed

> Written 2026-08-17 from a source read of `origin/main` @ `b4a44c1a6`, after the
> owner asked: *"你要检查一下我们所有系统的 Transfer To 和 Transfer From 的这些
> bug,还要查看一下正常大型 ERP 都是怎么去做的。然后我们就对照他们,把所有的东西都
> 完善掉,这样就不会有问题了(包括避免重复开单等问题)。"*
>
> §1–§8 above are about **entry points** — which screens offer a conversion.
> This section is about the **model underneath**: what stops the same goods
> being transferred twice. Different question, and the one that costs money when
> it is wrong.
>
> Every claim is labelled **PROVEN** (a command was run, or the source says it
> in words), **LIKELY** (consistent with the evidence, not yet observed) or
> **UNKNOWN**. Vendor claims carry a URL or they say UNKNOWN.
>
> **This section proposes no build and changes no behaviour.** It is the model.

## 9.1 The question, stripped of vocabulary

Every ERP in this comparison does the same three things and calls them
different names. Ours calls the action *Transfer from / Transfer to*; SAP calls
the record *document flow*; NetSuite calls the action *transform*; Business
Central calls the numbers *Quantity to Ship / Quantity Shipped*. The vocabulary
is not the mechanism. Six questions separate a sound model from an unsound one:

1. What is stored on the **source line** to record what has been consumed?
2. How is a **partial** transfer represented, and where does the remainder come
   from — stored, or recomputed?
3. What actually **prevents** a second transfer of the same quantity — a
   database constraint, a lock, a recomputed balance, or application code?
4. Is the guard per **LINE** or per **DOCUMENT**?
5. Is the flow **queryable** — a first-class table, or inferred from FKs?
6. What is the **reversal** story?

## 9.2 What our nine once-only pairs actually do

The grid in §2 lists thirteen source→destination pairs. Nine are **once-only per
line** and are the subject of this section. Two are deliberately not:

- **SO → PO is not once-only, by the owner's ruling of 2026-08-17.** MRP's
  shortage calculation is the authority on what still needs ordering, so a
  second PO against an already-purchased SO line is legitimate work, not a
  duplicate. The write path still carries a ceiling (below), but the *picker*
  answers to `computeMrp`. Compare that pair against planning-driven
  procurement, never against copy control. **It is not a missing guard.**
- **Consignment Order → Consignment Note is deliberately uncapped.**
  `consignment-notes.ts` says so in its own header: *"the SO-remaining over-pick
  guard (a loaner has no ordered-qty cap)"*, and again on the create path — *"a
  loaner has no ordered-qty cap and ships whatever is on the shelf."* PROVEN,
  and deliberate. It is a business decision of the same kind as the PO ruling.

For the rest, the mechanism is a **per-line quantity ceiling**, and
`backend/src/scm/lib/convert-ceilings.test.ts` states the invariant in one line:

> Σ(converted so far) + this conversion ≤ source qty

That file also records why a boolean "already converted" flag would have been
wrong: *"this business ships one order in several batches, so an SO that already
has a DO legitimately gets another DO"*. **The ceiling, not a flag, is the right
shape** — and it is the same shape every ERP below converged on.

### The mechanism, pair by pair — PROVEN by source read

`derived` = recomputed from downstream rows on every read, no stored counter.
`stored` = a counter column on the source line, maintained by a recount function.

| # | Pair | What records consumption | derived / stored | Pre-write cap | After-write recheck | Unlinked-line back door closed | A DRAFT downstream consumes? |
|---|---|---|---|:--:|:--:|:--:|:--:|
| 1 | SO → PO *(not once-only)* | `mfg_sales_order_items.po_qty_picked` | stored | `findOverConvertOffender` / `soLineHeadroom` / `soLineOverConvertRefusal` | **no** | **no** | — |
| 2 | SO → DO | `qty − delivered + returned`, via `so_item_id` **and** the DO header's `so_doc_no` | derived | `soDeliverableRemaining` | yes | **yes** | no |
| 3 | DO → SI | `delivered − invoiced − returned` | derived | `checkSiOverRemaining` | yes | **yes** | yes |
| 4 | DO → Delivery Return | same pool as #3 | derived | `checkDrOverRemaining` | yes | **yes** | yes |
| 5 | PO → GRN | `purchase_order_items.received_qty` | stored | `qtyCapRefusal` | yes | **yes** | no |
| 6 | GRN → PI | `grn_items.invoiced_qty` | stored | `qtyCapRefusal` | yes | **NO** | no |
| 7 | GRN → PR | `grn_items.returned_qty` | stored | `qtyCapRefusal` + `qty_exceeds_remaining` | yes | **yes** | yes |
| 8 | Consignment Order → Note *(uncapped by ruling)* | `ordered − delivered`, picker only | derived | **none** | **no** | **no** | — |
| 9 | Note → Consignment Return | `delivered − Σ qty_returned` | derived | `checkCrOverRemaining` | **no** | **no** | yes |
| 10 | PC Order → PC Receive | `purchase_consignment_order_items.received_qty` | stored | `qtyCapRefusal` | yes | **no** | yes |
| 11 | PC Receive → PC Return | `purchase_consignment_receive_items.returned_qty` | stored | `qtyCapRefusal` | yes | **no** | yes |

The three population claims in that table are mechanically checkable, and each
command is the definition of its column:

```enumeration
$ grep -rliE "race_conflict|post-insert" backend/src/scm/routes/ | sort
backend/src/scm/routes/delivery-orders-mfg.ts
backend/src/scm/routes/delivery-returns.ts
backend/src/scm/routes/grns.ts
backend/src/scm/routes/purchase-consignment-receives.ts
backend/src/scm/routes/purchase-consignment-returns.ts
backend/src/scm/routes/purchase-invoices.ts
backend/src/scm/routes/purchase-returns.ts
backend/src/scm/routes/sales-invoices.ts
```

```enumeration
$ grep -rlE "unlinked(SoLines|PoLines|Return|FromDo)" backend/src/scm/routes/ | sort
backend/src/scm/routes/delivery-orders-mfg.ts
backend/src/scm/routes/delivery-returns.ts
backend/src/scm/routes/grns.ts
backend/src/scm/routes/purchase-returns.ts
backend/src/scm/routes/sales-invoices.ts
```

```enumeration
$ grep -rl "\.post('/from-" backend/src/scm/routes/ | sort
backend/src/scm/routes/delivery-orders-mfg.ts
backend/src/scm/routes/delivery-returns.ts
backend/src/scm/routes/grns.ts
backend/src/scm/routes/mfg-purchase-orders.ts
backend/src/scm/routes/purchase-consignment-receives.ts
backend/src/scm/routes/purchase-consignment-returns.ts
backend/src/scm/routes/purchase-invoices.ts
backend/src/scm/routes/purchase-returns.ts
backend/src/scm/routes/sales-invoices.ts
```

The third list is nine, not eleven, and that is itself a finding: **the two
consignment pairs have no dedicated conversion endpoint.** Both convert through
the plain `POST /` create with linked line ids in the payload, so there is no
single handler on which a guard can be hung — which is exactly where two of the
three missing after-write rechecks are.

### Five cross-cutting facts, all PROVEN

1. **The database enforces nothing.** No `CHECK` constraint mentions
   `received_qty`, `invoiced_qty`, `returned_qty` or `po_qty_picked`; no unique
   index binds a child line to a source line; there is no document-flow table.
   `grep -rniE "CHECK *\(.*(received_qty|invoiced_qty|returned_qty|po_qty_picked)" backend/src/db/migrations-pg/`
   returns nothing. The whole invariant is application code, and
   `consignment-returns.ts` says so out loud: *"The insert surfaces nothing: no
   constraint stops an over-return, which is the entire reason this guard
   exists."*
2. **No conversion endpoint is idempotent.** No `Idempotency-Key`, no client
   request id, on any of the `from-*` POST endpoints. A double-submit is caught
   only by the quantity ceiling, and only if the counter has already moved.
3. **The flow is inferred at read time, not recorded.**
   `backend/src/scm/routes/document-flow.ts` builds the relationship graph — its
   own header calls it *"the SAP-Business-One-style Relationship Map"* — from
   the nullable FKs, per request. **No row anywhere says "this DO line took 4 of
   that SO line."** The quantity is only ever re-derived.
4. **The links are recorded, not enforced.**
   `docs/modules/document-traceability.md` §1 already states this for linkage B:
   every link column is nullable, an ad-hoc DO line is written with
   `so_item_id ?? null` straight from the client payload, and several have been
   rewritten by repair scripts. LIKELY (from `do-unlinked-coverage.ts`'s own
   header, not from DDL in this repo): the SO-line FK is `ON DELETE SET NULL`, so
   deleting one SO line blanks the pointer on every downstream document that
   served it.
5. **Two precedents for database-side enforcement already exist here.**
   `scm.fn_po_item_alloc_guard()` + `trg_po_item_alloc_guard` (mig 0235) locks
   the parent PO line `FOR UPDATE` and refuses when `SUM(children.qty) >
   parent.qty`; `apply_so_header_cas` is a compare-and-swap RPC. So the pattern
   in §9.6 is not new engineering — it is one already-shipped file, applied
   wider.

### The seam: we run TWO mechanisms, not one

The split is clean and nobody chose it deliberately:

- The **sales chain derives live.** `do-line-remaining.ts` says why:
  *"The number is always DERIVED LIVE from the rows; there is no stored counter
  to drift."* Cancel a downstream document and the quantity re-derives back into
  the pool with no recount to run.
- The **purchase chain reads a stored counter.** `convert-ceilings.test.ts`
  flags it: *"Unlike every path above, this one reads a STORED counter rather
  than deriving the sum live."*
- **Only the stored half has a shared helper, and it cannot be extended to the
  other half.** `backend/src/scm/lib/qty-cap.ts` takes a `capColumn` and
  `drawnColumns` on ONE row, so it is structurally unable to express
  `delivered − invoiced − returned` over downstream rows. Its call sites land on
  the five purchase-side routers and nowhere else:

```enumeration
$ grep -rc "qtyCapRefusal(" backend/src/scm/routes/ | grep -v ":0$" | sort
backend/src/scm/routes/grns.ts:2
backend/src/scm/routes/purchase-consignment-receives.ts:2
backend/src/scm/routes/purchase-consignment-returns.ts:2
backend/src/scm/routes/purchase-invoices.ts:2
backend/src/scm/routes/purchase-returns.ts:2
```

  So the abstraction that exists cannot become the one mechanism, and that is
  the argument for putting the ceiling somewhere both halves already meet — the
  database (§9.5).

## 9.3 How established ERPs do it

Sources are primary vendor documentation or vendor source code wherever a URL is
given. Where primary documentation could not be reached, the cell says UNKNOWN
rather than repeating a summary.

### The comparison, per mechanism

| | **SAP** (ERP / S4HANA SD) | **NetSuite** | **Odoo 17/18** | **Business Central** | **AutoCount** | **OURS** |
|---|---|---|---|---|---|---|
| **1. What the source line records** | A **status only** — Not / Partially / Fully referenced. The quantity lives in the flow table, not on the line. PROVEN | Per-line counters `quantityFulfilled` / `quantityBilled` / `quantityCommitted` / `quantityBackOrdered` (+`quantityPicked`/`Packed`); PO side `quantityReceived` / `quantityBilled`. PROVEN they exist; that they are counters is LIKELY | Stored **computed aggregates** — `qty_delivered`, `qty_invoiced`, `qty_to_invoice`, all `compute=… store=True`. Nothing is an incremented counter. PROVEN | Per-line stored numbers: `Quantity Shipped`, `Quantity Invoiced`, `Outstanding Quantity`, `Qty. Shipped Not Invoiced`. PROVEN the fields exist; stored-vs-FlowField is **UNKNOWN** | Per-line `TransferedQty` + `IsTransferred`, plus master `ToDocType`/`ToDocKey`. PROVEN as API fields; physical column **UNKNOWN** | **Two models.** Sales chain: nothing — derived live. Purchase chain: counters `received_qty` / `invoiced_qty` / `returned_qty` / `po_qty_picked` |
| **2. Partial, and where the remainder comes from** | Status stored, remainder **computed** — *"order quantity minus the quantity already invoiced"*. PROVEN | Downstream line carries `orderLine` + `quantityRemaining`; Oracle's own dataset computes remaining by formula over `quantityshiprecv`, so derived. PROVEN | Remainder is a formula: `qty_to_invoice = product_uom_qty − qty_invoiced`. **There is no remaining-to-deliver field at all** — recomputed live from moves. PROVEN | `Qty. to Invoice` is documented as `Quantity − Qty. Invoiced` — computed, then written down. PROVEN | `PartialTransfer(…, qtyToTransfer, …)` per line, with a `DtlKey` overload. PROVEN | Sales: `delivered − invoiced − returned`, live. Purchase: `qty − counter` |
| **3. What actually prevents a double draw** | **Application layer.** Copying-requirement routines (*"If another document refers to the document or item, copying is not allowed"*), the item-category **completion rule**, and a tolerance check that sums sibling documents. **No DB constraint documented.** PROVEN | **Application check, and it is a SETTING** — *Allow Overage on Item Fulfillments / Item Receipts*; refused by default, switchable. Plus `CANT_UPDATE_RECRD_HAS_CHANGED`. No DB constraint documented. PROVEN | **Recomputed sum + the UI skipping exhausted lines.** `_get_invoiceable_lines` skips `qty_to_invoice == 0`. `_sql_constraints` carry **no quantity constraint**. Editing a draft invoice line upward is *not* blocked. PROVEN | **Application AL checks that throw** — `MaxQtyToShipBase` *"ensures that the quantity to ship does not exceed the outstanding quantity"*; `Sales-Post` throws on over-invoice. No CHECK constraint documented. PROVEN | **A filtered picker** — *"the outstanding items available for transfer will be listed"*, plus an `Allow to Transfer` flag. Not a DB constraint. PROVEN | **Application checks only.** No CHECK constraint, no unique index, no flow table. Pre-write cap + (on 8 of 11) an after-write delete |
| **4. Per line or per document** | **Per ITEM**; header status is the aggregate — *"In all other situations, the document is assigned the status of partially referenced."* PROVEN | **Per line**, with a document-level delete guard (*"You can't delete a transaction if it's linked to other transactions."*) PROVEN | **Per line.** A confirmed order's line cannot be deleted — *"Set the quantity to 0 instead."* PROVEN | **Per line.** Order lines survive full shipment and invoicing; only a batch job deletes the document. PROVEN | **Per line** — items colour-coded beige = partial, blue/grey = full. One source may feed many targets. PROVEN | **Per line**, universally |
| **5. Is the flow queryable** | **Yes, first class: `VBFA`** — `VBELV`/`POSNV` → `VBELN`/`POSNN`, `VBTYP_N`/`VBTYP_V`, **and the reference quantity `RFMNG`** ("Reference quantity in the base unit of measure"), `RFWRT`, `MEINS`. PROVEN. Whether the successor is updated too is a copy-control switch (*Update document flow*) | **Yes: `nexttransactionlinelink`** — `previousdoc`/`previousline`/`previoustype` → `nextdoc`/`nextline`/`nexttype`, `linktype`, `foreignamount`. **PROVEN that it carries NO quantity column — only an amount.** Plus `createdFrom` and `orderLine` | **Partly.** Sales invoicing has a real m2m `sale_order_line_invoice_rel` (PK on the pair). **Purchase invoicing is only a plain FK `purchase_line_id`** — not symmetric. No generic flow table. PROVEN | **No.** Inferred from FKs — `Sales Shipment Line.Order No.` + `Order Line No.`. No VBFA analogue. PROVEN | **Yes: `DocTransfer`** (`FromDocDtlKey` → `ToDocKey`), plus `FromDocNo`/`FromDocDtlKey` on the detail row, a View Flow screen and Outstanding reports. PROVEN. Per-link quantity column **UNKNOWN** | **No.** `document-flow.ts` rebuilds the graph from nullable FKs per request. No row records a transfer |
| **6. Reversal** | A **new reverse document** (cancellation billing type F2→S1 — *"open for billing again"*; Returns / Credit memo request via copy control). Append-only in spirit. Whether VBFA rows are deleted or negated: **UNKNOWN** | Delete the Item Fulfillment (SO returns to *Pending Fulfillment*) — arithmetic LIKELY; or **Void**, preferred *"because the audit trail is preserved"*; or transform invoice→credit memo. PROVEN | **Credit note, and the sum re-evaluates itself.** The refund's line joins the SAME m2m and `_compute_qty_invoiced` subtracts `out_refund`. **No counter is decremented; there is no unlink.** PROVEN | **Two routes: `Undo Shipment`** — before invoicing, and it **writes the counters back** (`Quantity Received` / `Qty. Rcd. Not Invoiced` *"set to zero"* on the PO) — or a credit memo, which resets `Qty. Invoiced` to its pre-posting value. PROVEN | **Un-transfer** (untick the source in the target) restores outstanding; or a dedicated **Cancel SO / Delivery Return / Goods Return / Credit Note**, each itself built on Transfer. PROVEN | **Cancel.** Sales chain: derived, so cancelling re-derives the qty back with nothing to run. Purchase chain: a recount must fire, and it is best-effort |

### The four things this comparison actually settles

**a. Not one of them uses a database constraint.** SAP, NetSuite, Odoo, Business
Central and AutoCount all enforce this invariant in application code. PROVEN for
all five, insofar as absence from primary documentation proves it — and for Odoo
it is proven positively, by reading `_sql_constraints` and finding no quantity
constraint there. **So we are not behind on question 3; we are level.** What §9.5
Part 2 proposes is therefore *not* copying anyone — it is a deliberate step past
industry practice, and the justification has to come from our own architecture
rather than from precedent (see the note at the end of Part 2).

**b. The industry is unanimous on questions 2 and 4, and we already match.** The
remainder is **arithmetic over a per-LINE quantity**, never a boolean, and never
per document. All five. Our per-line ceiling is the right shape, and
`convert-ceilings.test.ts` reached that conclusion from the business rather than
from the literature.

**c. Our purchase chain is Odoo's model with the recompute made manual — which
is precisely why it drifts.** Odoo stores the same kind of number we do, but its
value is a `compute=… store=True` aggregate that the ORM re-evaluates whenever a
dependency changes (`@api.depends('invoice_lines.move_id.state', 'invoice_lines.quantity')`).
Our `received_qty` is the same figure with the invalidation replaced by a
hand-called, best-effort `recomputePoReceived`. **G2 is not a bug in our
arithmetic; it is the missing half of a pattern we half-adopted.** The sales
chain, by refusing to store the number at all, sidestepped it.

**d. Business Central answers the DRAFT question with TWO numbers, not one.** An
intent figure on the still-open line (`Qty. to Ship` / `Qty. to Invoice`) and a
consumed figure written by posting (`Quantity Shipped` / `Quantity Invoiced`),
with `Qty. Shipped Not Invoiced` bridging them. That is the structural answer to
G3: our single number forces DRAFT to be either consuming or not, and we picked
opposite answers on different pairs. It is also the right *eventual* target and
the wrong first step — see §9.5 Part 3.

### Two premises worth correcting, since they were in the brief

- **SAP's completion rule is NOT in copy control.** It is defined on the **item
  category** — *"You can define the completion rule in Customizing … when you
  define item categories"*. PROVEN. What copy control carries for this purpose is
  the header's *Complete reference* and the item's *Update document flow*,
  *Copy quantity* and *Pos./neg. quantity*. The A/B/C value table for the
  completion rule appears only in SAP-PRESS and Community material — **LIKELY**,
  and its technical field name is **UNKNOWN**; it is not `UEPOS` (that is the
  higher-level item).
- **Order→order copy control is `VTAA`, not `VTLA`.** And every one of `VTAA` /
  `VTLA` / `VTFA` / `VTFL` / `TVCPA` / `TVCPL` is **LIKELY** only: current SAP
  documentation names the configuration activities in words, and the transaction
  codes and table names appear on secondary sites. Likewise `RFMNG_FLT`, `PLMIN`
  and the `VBUP`/`VBUK` → `VBAK`/`VBAP` consolidation: **LIKELY**, DDIC-mirror
  sites only. `RFMNG` itself is **PROVEN** from SAP's own field-mapping page.
- **NetSuite's `linkedorderline` could not be found in any primary source** —
  treat it as unverified. What NetSuite actually stores line-to-line is
  `orderLine` on the downstream line plus `nexttransactionlinelink`.

## 9.4 The gap list, ranked by what can actually go wrong

Ranked by consequence, not by tidiness. "We use different words" is not on this
list.

### G1 — GRN → PI is the one money chain with no unlinked-line guard. A supplier's goods can be billed twice.

**PROVEN.** `purchase_invoice_items.grn_item_id` is nullable and a NULL is
legitimate — it is how a PI-native service line is represented. Every cap and
every recount in `purchase-invoices.ts` filters NULLs out first
(`ids.filter(Boolean)` in `recomputeGrnInvoiced`, in
`verifyGrnLinesNotOverInvoiced`, and `qtyCapRefusal` returns `null` = uncapped
when there is no capping row). So a Purchase Invoice whose header names a GRN
can carry a hand-added line for a material that **is** on that GRN with
outstanding qty: it bills the goods, `invoiced_qty` never moves, the GRN line
still reads fully outstanding, and a second PI can bill the same receipt. Both
post AP, and both enqueue to AutoCount via `enqueueConvert`.

`grep -ci unlinked backend/src/scm/routes/purchase-invoices.ts` returns **0**.
Every sibling chain closes this door and names the reason. `sales-invoices.ts`
describes the identical vector on its own chain and blocks it
(`unlinkedFromDoOffenders`): *"An UNLINKED line whose item code STILL has
Pending qty on the source DO is the double-invoice vector."*
`grn-unlinked-po-lines.ts` was written for the receiving side on the owner's
2026-08-04 instruction *"包括 GR 那边也是"*. The invoicing side of the same chain
was not done.

This is the top item because it is the AP twin of a defect the owner already
reported and paid to fix on three other chains, it is on the money path, and it
propagates into the book we reconcile against.

### G2 — The purchase chain's counter is a CACHE maintained best-effort, and it has already drifted in production.

**PROVEN.** `received_qty` is the authority for whether a PO line may be
received again, and it is written by `recomputePoReceived`, whose body is
wrapped in a try/catch that historically only `console.error`d. Migration
`backend/src/db/migrations-pg/0231_po_received_qty_backfill.sql` (mig 0231) exists
because of the consequence: eleven consecutive GRNs posted, moved stock, and
never moved their parent PO. Its header states it plainly — *"eleven POs sat with their goods in the warehouse
and received_qty untouched"* — and every affected PO's `updated_at` was still
its own creation timestamp.

An **under-counting** cache reads as outstanding, so the picker offers the line
again and the same delivery can be received a second time. An **over-counting**
cache makes real outstanding work invisible. The sales chain cannot fail this
way by construction. The remedy shipped in 2026-07 was to stop swallowing the
outcome (the failure now reaches the GRN's audit trail and the response), which
makes the drift *visible* — it does not make the counter *authoritative*.

### G3 — DRAFT policy is decided three different ways, and where a DRAFT does not consume, two documents can be raised for the same line.

**PROVEN.** Three incompatible answers to one question coexist:

| policy | pairs | failure mode |
|---|---|---|
| a DRAFT downstream does **not** consume | SO → DO, PO → GRN, GRN → PI | **two documents for one line.** Both are keyed, both look valid, and the second is refused only at confirm/post — after the operator has done the work. `grns.ts` states the consequence as a feature: *"two drafts can coexist on one PO line"*. |
| a DRAFT downstream **does** consume | DO → SI, DO → DR, GRN → PR, PC Order → PC Receive, PC Receive → PC Return | an abandoned draft blocks the line until somebody cancels it. Recoverable, but invisible: the picker just stops offering the line. |
| **no cap at all** | Consignment Order → Note | by ruling. |

This is the owner's *重复开单* in its most literal form, and the split is not a
decision anyone recorded — it is eleven local decisions. Note which direction
each failure runs: the "does not consume" failure ends with two real documents
and possibly moved goods; the "does consume" failure ends with a stuck line and
a cancel. Those costs are not symmetric.

### G4 — Nothing is atomic. Eight of eleven pairs paper over the race by deleting what they just created; three do not paper over it at all.

**PROVEN.** Every pair is read-then-write across PostgREST round trips, and
`do-line-remaining.ts` states the exposure exactly: *"Two invoices raised
against the same delivered goods at the same moment BOTH read the same
remaining, BOTH pass, and BOTH insert — the customer is billed twice for one
delivery."*

The repair applied on eight chains is a **post-insert compensating check**: let
the write land, re-read, and if it broke the cap, delete the document and answer
409. `grns.ts` is candid about the cost — the rollback deletes *"a receipt the
operator watched succeed"* — and about the limit: those verifiers are
*"deliberately left best-effort"*, because a rollback that itself fails leaves
the over-receipt standing. **SO → PO, Consignment Order → Note and Note →
Consignment Return have no second half at all.**

### G5 — Six of the eleven chains close no unlinked-line back door, and two of those have no endpoint to close it on.

**PROVEN** (second enumeration block, §9.2). The five that close it are SO → DO,
DO → SI, DO → DR, PO → GRN, GRN → PR. The six that do not are GRN → PI (G1) and
all four consignment / purchase-consignment chains, plus SO → PO. On the two
consignment pairs this is structural: the conversion is an ordinary `POST /`, so
there is no conversion handler to gate.

`convert-ceilings.test.ts` pins the general shape as a KNOWN EXPOSURE with a
real production case — *"DO-2607-005 on SO-2606-019 shipped with NULL
so_item_id, which is precisely why the over-delivery guard stayed blind while a
second DO shipped the same goods"* — and the SO → DO arm has since been given a
second reading (`do-unlinked-coverage.ts`, added 2026-08-17 after the owner's
*"已经出货了为什么 MRP 还叫我下单"*). **No such second reading exists on the
purchase side**: `recomputePoReceived` reads `purchase_order_item_id` only, with
no fallback to `grns.purchase_order_id`.

### G6 — The transfer itself is never recorded, so a historical transfer can only be recomputed, never audited.

**PROVEN.** There is no row stating "child line X took N units of parent line
Y". `document-flow.ts` reconstructs the graph from FKs per request, and every
remaining-quantity function re-derives the sum. Two consequences:

- **Recomputation applies today's rules to yesterday's rows.** The DRAFT and
  CANCELLED filters in §9.2 are in application code, so changing one silently
  restates history.
- **A per-transfer quantity cannot be recovered.** A child line's own `qty` is
  what it holds *now*; if it was edited after creation, the quantity it
  originally drew is gone. This bounds what §9.5 can honestly backfill.

The system's current answer at document level is a **detector, not a
prevention**: `backend/scripts/check-duplicate-documents.mjs`, run by
`.github/workflows/duplicate-documents-check.yml`, is read-only and heuristic
(line-multiset match, counterparty, date window). It exists because of a real
pair — same supplier, same date, identical lines, one received and shipped and
one never executed, with the unexecuted twin inflating MRP supply. Useful, and
downstream of the problem.

## 9.5 The recommended target model for THIS system

One mechanism, three parts, applied to all nine once-only pairs so a tenth pair
inherits it. Nothing here is novel; each part is an existing file applied wider.

### Part 1 — the LINK is required wherever the material is on the named parent

Already shipped on five chains (`do-unlinked-so-lines.ts` and the two modules
that share its predicate). Extend the same predicate to GRN → PI and the four
consignment chains. The rule is already written and already agreed:

```
header names no parent            -> nothing to bypass, allowed
material is NOT on the parent     -> genuinely free line, allowed
material IS on the parent         -> REFUSED: link it, and tick the qty off
```

**Cost: no schema change, no migration, no backfill.** For the two consignment
pairs it also means the conversion needs a real endpoint (or a `sourceKind`
discriminator on the create) so the guard has somewhere to live. This part alone
closes G1 and G5.

### Part 2 — the CEILING moves into the database, as a trigger, copied from mig 0235

`scm.fn_po_item_alloc_guard()` already does exactly the required thing for a
different table: `BEFORE INSERT OR UPDATE`, `SELECT ... FOR UPDATE` on the
parent line, sum the live siblings, `RAISE EXCEPTION` when the sum exceeds the
parent's qty. Its own `COMMENT ON FUNCTION` describes the property that matters
here — it *"locks the parent row FOR UPDATE so concurrent writers on one line
serialise instead of both passing a stale sum."*

One such trigger per child-line table, parameterised by (child table, link
column, parent table, cap column, the sibling-status filter). Mig 0235's second
trigger, `trg_po_item_qty_guard`, is the other half already written: a parent
line may not shrink below what its children hold.

What this buys, and it is the whole point: **the read-then-write race stops
being real**, so every post-insert compensating delete in G4 can be retired
rather than replicated onto the three chains that lack one. A refusal then
happens *before* the row exists, which is the cheap direction — `qty-cap.ts`
already argues this: *"Every one of the ten call sites is a PRE-write gate.
Refusing costs the operator a retry and writes nothing."*

**Cost.** One migration per child-line table — nine, or one file if the function
is generic and driven by a small registry. **No table gains a column. No
backfill:** the trigger judges the live sum of children, so it never asks what
history was. It does mean an over-drawn *historical* row makes its parent
un-shrinkable until reconciled, which is a finding surfaced by the trigger, not
damage caused by it. The existing stored counters stay as a read cache and stop
being the authority — which demotes G2 from a correctness bug to a display bug.

Note the ordering dependency: **Part 2 without Part 1 is a false sense of
safety.** A trigger can only see rows that carry the link. That is not a reason
to sequence them; it is a reason to ship them together.

**Be honest that this goes further than any vendor here does.** §9.3 establishes
that not one of SAP, NetSuite, Odoo, Business Central or AutoCount enforces this
in the database — all five do it in application code. So Part 2 cannot be
justified by precedent, and must be justified by our own architecture, which
differs from all five in the way that matters:

- **We have no unit of work.** Ours is PostgREST: separate HTTP round trips, no
  shared transaction, so the window between check and write is **not closeable in
  the route at all**. That is PROVEN, and it is exactly why eight chains ended up
  deleting documents after the fact. That the five vendors run their check inside
  a transaction that also writes the row is **LIKELY** — it follows from an ORM /
  AL / ABAP-LUW execution model — but none of them documents it, so the argument
  here rests on OUR constraint, which is measured, not on theirs, which is
  inferred.
- **The client bypasses RLS.** The SCM client is the service role
  (CLAUDE.md), so no policy is ever evaluated. A trigger is the only layer below
  the route that still runs.
- **Two write paths per pair, not one** — the convert endpoint and the
  add-line/edit-line handlers — plus a mobile surface. A route-level guard has to
  be remembered at each; a trigger cannot be forgotten.

Under those three conditions the trigger is not gold-plating: it is the first
enforcement point that exists at all. Where the vendors' architecture already
gives them one, ours does not.

### Part 3 — ONE predicate decides what consumes, so DRAFT is one decision and not eleven

The status filters in §9.2 should be a single SQL predicate that the trigger and
the picker both read, not eleven hand-written `status !== 'CANCELLED'` lists.
Written once, it can also be *changed* once — today, changing the DRAFT rule
means finding eleven places and getting all of them.

**The recommendation on the DRAFT question itself is that a DRAFT consumes, and
that it is visible while it does.** Reasoning, not preference: the two failures
in G3 are not symmetric. A stuck line is recovered by cancelling a draft; two
keyed documents are recovered by finding out which one is real, possibly after
goods have moved and after both have propagated to AutoCount. Business Central
carries two numbers rather than one for exactly this reason — an intent figure
on the open line and a consumed figure from the posted document — and that is
the shape to copy if one number proves too coarse. It is not needed on day one:
one number plus "a draft consumes, and the picker says which draft holds it"
gets the safety without the second column.

### What cannot be honestly reconstructed

If G6 is ever closed with a real flow table — `(parent_line, child_line, qty)`,
the shape AutoCount's `DocTransfer` reconciles against — then **history cannot
be backfilled faithfully.** The per-transfer quantity was never stored. It can
be inferred as the child line's current `qty` only where that line has not been
edited since creation, and **this system has no field that proves that**:
`updated_at` moves for reasons unrelated to quantity. So a backfill would be a
plausible reconstruction presented as a record, which is the thing CLAUDE.md
forbids. Recommendation: build the table **forward-only**, stamp the cutover
date on it, and leave history to the derived read that already works. UNKNOWN,
and it should stay UNKNOWN rather than be filled with arithmetic.

## 9.6 What NOT to adopt

This is a two-company furniture business with one Worker and one SPA. Several
mechanisms below are correct for their vendor and would be worse than the
current state here.

- **SAP's copy control as a configurable layer.** Naming the parts that do not
  earn their complexity here:
  - **Per-pair copying-requirement routines and data-transfer routines** — code
    registered in configuration and invoked by number. The whole value of that
    indirection is letting a consultant change behaviour without a deploy; we
    deploy from a PR in minutes, and an invariant that can be reconfigured is an
    invariant with a way to be switched off.
  - **The completion rule as a SETTING.** We have exactly one answer
    (quantity-conserving) and nine pairs; making it configurable creates nine
    settings whose wrong value is invisible. Note also where it actually lives —
    SAP defines it on the **item category**, not in copy control (§9.3) — so
    "put it in copy control" would have been the wrong shape as well as
    unnecessary.
  - **`Update document flow` as a per-pair switch.** SAP needs it because
    writing the successor's flow record is optional work; we need the link
    written every time, so a switch only adds a way to have half a graph.
  - **`Pos./neg. quantity` / `PLMIN` sign handling**, and **value-based
    transfer**. Our returns are their own documents with their own quantities,
    and we have no transfer-by-value flow at all. AutoCount's separate
    value-outstanding track (§9.7) is a reason to keep it that way.

  Take the *invariant* SAP encodes — per-item, quantity-conserving, exhausted
  when the referenced quantity is consumed. Leave the configurability.
- **A link row that carries an AMOUNT instead of a quantity.** NetSuite's
  `nexttransactionlinelink` carries `foreignamount` and no quantity column
  (PROVEN, §9.3), so quantity consumed still has to be read off the downstream
  line. If we ever build the table in §9.5, the quantity is the entire point of
  building it; copying NetSuite's column set would leave us with the cost and
  none of the benefit.
- **Odoo's asymmetry.** Odoo has a real join table on the sales-invoice hop and
  only a plain FK on the purchase-invoice hop (PROVEN, §9.3). That asymmetry is
  the shape our own system already has too much of; it is not a precedent to
  lean on.
- **AutoCount's Full Transfer semantics.** See §9.7 — this one is not merely
  unnecessary, it is unsafe for us.
- **A boolean "already transferred" flag per document.** Already ruled out, on
  the business: this trade ships one order in several batches
  (`convert-ceilings.test.ts`). A document-level flag also cannot represent one
  source line split across two targets — AutoCount's own document-level
  `ToDocKey` is a single scalar and AutoCount itself falls back to a link table
  for that case.
- **Retrofitting a full flow table before Parts 1 and 2.** It answers G6, which
  is an auditability gap, while G1 and G3 are money and duplicate-document gaps.
  Sequencing it first buys the least urgent thing at the highest cost.

## 9.7 Does AutoCount constrain the answer? Yes, in two ways — one permissive, one prohibitive.

This matters more than any textbook: we must not invent a model the book cannot
represent.

**Permissive — our shape is already compatible, so nothing here is blocked.**
AutoCount tracks transfer **per detail line**, quantity-parameterised, and keeps
a first-class link table:

- A real linkage table `DocTransfer`, with `FromDocDtlKey` and `ToDocKey`,
  joinable as `sourceDtl.DtlKey = DocTransfer.FromDocDtlKey`. PROVEN — the
  vendor publishes SQL against it in its own report-designer FAQ
  ([wiki.autocountsoft.com](https://wiki.autocountsoft.com/wiki/Accounting_2.0_-_How_to_show_Sales_Order_Doc_Number_in_Invoice_Report)).
- Per-line `TransferedQty` (one "r") and `IsTransferred`, plus
  `FromDocType` / `FromDocNo` / `FromDocDtlKey` back-pointers on the detail row.
  PROVEN as API field names in the vendor's own AOTG payload documentation
  ([AOTG API: Create Cash Sale](https://wiki.autocountsoft.com/wiki/AOTG_API:_Create_Cash_Sale)).
  Whether `TransferedQty` is a physical stored column or a computed value is
  **UNKNOWN** — no schema page was reachable.
- A document-level `ToDocType` / `ToDocKey` on the master, which is what drives
  the grey-out / edit lock. PROVEN
  ([un-transfer troubleshooting](https://wiki.autocountsoft.com/wiki/Purchase:_Unable_to_edit_GRN_after_un-transfer_GRN_to_Purchase_Invoice)).
- Partial transfer is per-line and takes an explicit quantity —
  `PartialTransfer(TransferFrom, docNo, itemCode, uom, qtyToTransfer, focQtyToTransfer)`,
  with an overload taking the source line's `DtlKey`. PROVEN
  ([Programmer:Delivery_Order](https://wiki.autocountsoft.com/wiki/Programmer:Delivery_Order)).
- The guard is an **application-filtered picker**, not a database constraint:
  *"the outstanding items available for transfer will be listed"*
  ([Common Function in Transaction](https://wiki.autocountsoft.com/wiki/Non_Module:_Common_Function_in_Transaction)).
  So AutoCount's own answer to question 3 is the same as ours today.

**So: our per-line quantity ceiling is shape-compatible with the book, and
Part 2 (a database trigger) is strictly stronger than what AutoCount does
without diverging from what it can represent.** If a flow table is ever built
(§9.5), key it per **line pair with a quantity** — that is what `DocTransfer` +
`TransferedQty` can be reconciled against. A document-level flag cannot.

**Prohibitive — do NOT copy Full Transfer.** AutoCount's Full Transfer closes
the source rather than doing arithmetic on it. The vendor states the
consequence: *"After full transfer is performed, there will be no outstanding in
the source document, regardless if the target quantity has been reduced"*
([GRN transfer from PO](https://wiki.autocountsoft.com/wiki/Programmer:Goods_Received_Note_Transfer_from_Purchase_Order_v2)).
Full-transfer an SO of 10 into a DO, then edit the DO down to 3, and the seven
are silently gone. Our arithmetic is quantity-conserving on every pair, and
`convert-ceilings.test.ts` pins that an amendment moves the ceiling rather than
bypassing it. **Adopting AutoCount's full-transfer semantics would lose balances
this system currently keeps.** Keep only Partial Transfer's per-line,
per-quantity semantics.

**Two AutoCount facts worth carrying into the sync, not the model.** PROVEN:
value-outstanding and quantity-outstanding are separate tracks in AutoCount
(*"Remaining Amount … will not reduce when you do any full/partial item
transfer"*), so a value figure from the book must never be read as a quantity
balance. And AutoCount has a documented integrity hole of its own — deleting
rows in a transferred target leaves the link behind and the source locked, with
a dealer-level *Fix Deleted Document Transfer Problem* repair as the remedy — so
**orphaned `DocTransfer` rows are a state the sync should expect rather than
treat as impossible.**

## 9.8 What this section deliberately did not settle

- **Whether the counters have drifted on `main` today.** Migration 0231 proves
  the mechanism drifted once and repaired that window convergently. Whether any
  line is drifted *now* is a live-database question and cannot be answered from
  source. The honest next step is a read-only check plus a
  `workflow_dispatch` (the `check-soak-gate.mjs` shape), not a number typed
  here.
- **How many production rows carry a NULL link on each chain.** Same reason. The
  four figures the repo already records are dated and scoped to their incident;
  none of them is a current system-wide count.
- **The `ON DELETE` behaviour of the link FKs**, beyond mig 0235's two columns.
  The DDL for `delivery_order_items` and `grn_items` is not in this repo's
  `migrations-pg` tree, so the `ON DELETE SET NULL` claim rests on a source
  comment. LIKELY, not PROVEN, and settled by one query against the live
  catalog.

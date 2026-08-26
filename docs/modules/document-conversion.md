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
| 7 | **DO → Delivery Return** | yes | **yes** | lines across many DOs | DO list **row menu** "Transfer to Delivery Return" (one DO, scoped — §4a, §8a). Added 2026-08-22 on the owner's ask; the picker had existed and read no parameter until then | **none** |
| 8 | **Consignment Order → Consignment Note** | yes | yes (whole-order only) | lines across many COs | CO list row menu + CO detail "Create Consignment Note" — prefills the WHOLE order, no line picking | **S** |
| 9 | **CN → Consignment Return** | yes | yes | lines across many CNs | CN detail "Create Consignment Return" | **none** |
| 10 | **PC Order → PC Receive** | yes | **no** | yes | — (deliberately dropped, see §5) | **S** |
| 11 | **PC Receive → PC Return** | yes | **no** | yes | — (deliberately dropped) | **S** |
| 12 | **Quotation → SO** | **no** | **no** | — | **does not exist at all** (§5) | **L** |
| 13 | SO → Consignment Note | **no** | **no** | — | deliberate: *"a consignment note is free-entry"* | n/a |

### What the grid says, plainly

- **FIVE pairs now have a complete, working "Convert to"**: PO → GRN, DO → SI,
  GRN → PI, SO → DO and — since 2026-08-22 — DO → Delivery Return. It was ONE
  when this guide was written; three were repaired the same day (§4a) and the
  fifth arrived with the Delivery Order row menu (§8a). Everything else is
  *missing* the button rather than having a broken one.
- **Two pairs have no "Convert to" at all**: PC Order → PC Receive, PC Receive →
  PC Return.
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

> **The CN list's status WORD changed on 2026-08-26, its conversion surface did
> not.** `DISPATCHED` reads **Loaded** rather than "Shipped" on the CN list, and
> the CN DETAIL page needed no edit at all — it renders the shared
> `<StatusPill docType="do">` and inherits the canonical map, which is what that
> layer is for. The owner's rule is that a consignment note mirrors a delivery
> order, so the two vocabularies move together. Stored values are untouched. Full
> reasoning: `docs/modules/document-status-vocabulary.md`.

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

### The wizard's picker reads are wired into the shared invalidation (2026-08-21)

The wizard keys its three reads under private roots it invented —
`["convert-source", …]`, `["convert-lines", …]`, `["convert-grn-lines", …]` —
and until 2026-08-21 they were in **nobody's** invalidation set. A convert
completed anywhere else (a desktop picker, another mobile flow, or this wizard a
moment earlier) therefore left a MOUNTED phone wizard still offering lines that
had already been consumed: `over_remaining` on submit at best, and where the
pool had only partly shrunk, a wrong quantity going through instead.

All three now ride `invalidateConvertShared` (`frontend/src/mobile/sharedInvalidate.ts`,
`CONVERT_PICKER_ROOTS`), which every convert already calls. **Add a picker root
there, never a fourth private key at the call site** — inventing the key locally
is what produced the first three. Pinned by
`frontend/src/mobile/convertWizardInvalidation.test.tsx`.

> **Limit, stated plainly.** This covers converts inside ONE browser, plus other
> TABS via the BroadcastChannel in `lib/cross-tab-sync.ts`. A convert on a
> physically different DEVICE still cannot reach the phone until the query goes
> stale on its own — there is no server push, and `refetchOnWindowFocus` is what
> actually rescues that case. The server's own `over_remaining` / `409` refusal
> remains the real guard, and it always was.

### 6b. Why the other six pairs are still NOT on the wizard (assessed 2026-08-21)

The wizard covers four of the ten desktop `*From*` pickers. The remaining six
were each assessed against three questions — does a convert endpoint exist that
takes the wizard's shape, can the document be raised as a DRAFT, and is it work
done away from a desk. **All six fail on the DRAFT question, and that is not a
mobile problem — it is the shape of those documents.**

The wizard's rule, bought by defect #2555 (the DO arm shipped without `asDraft`
and a phone convert dispatched stock immediately): **an arm that cannot send a
draft flag must not exist.** A phone convert parks a document for review; it does
not move stock or post to the ledger on a tap.

| Pair | Convert endpoint | Draft possible? | Verdict |
|---|---|---|---|
| DO → **Delivery Return** | `POST /delivery-returns/from-do` — takes `picks:[{doItemId, qty, condition}]`, i.e. exactly the wizard's shape | **No.** `grep -c DRAFT backend/src/scm/routes/delivery-returns.ts` = **0**. Hardcodes `status: 'RECEIVED'` and calls `increaseInventoryForReturn` in the same request. | **Closest to accidental, and still blocked.** The endpoint fits; the document has no draft state at all, so a phone tap would move stock straight back into inventory with no review. Needs a backend DRAFT state first — an owner decision, not a UI change. |
| GRN → **Purchase Invoice** | `POST /purchase-invoices/from-grn-items` (line-level), `/from-grn` (whole) | **No.** Both hardcode `status: 'POSTED'` + `posted_at`. The BARE `POST /` does support `asDraft`, but the convert handlers never read it. | Not added. Posting a supplier invoice to AP is also desk work — it is matching a supplier's paperwork against a receipt, not something done in a warehouse aisle. |
| PCO → **PC Receive** | `POST /purchase-consignment-receives/from-pcos` | **No, explicitly.** `if (body.status === 'DRAFT') return … 'draft_status_not_supported'` — *"Consignment receives post immediately on create."* | Not added. Also takes WHOLE orders (`purchaseConsignmentOrderIds[]`), so the wizard's line+qty step would have nothing to drive. |
| PC Receive → **PC Return** | `POST /purchase-consignment-returns/from-pc-receives` | **No, explicitly** — same refusal. | Not added. Same whole-document shape (`pcReceiveIds[]`). |
| CO → **Consignment Note** | **None.** `GET /consignment-notes/deliverable-order-lines` exists (the picker read), but creation is `POST /` then `POST /:id/items`. | n/a | Not added. Would need a new backend converter, which is a backend change with its own consume-accounting decisions, not a wizard arm. |
| CN → **Consignment Return** | **None.** `GET /consignment-returns/returnable-note-lines` exists; creation is `POST /` then `POST /:id/items`. | n/a | Not added. Same as above. |

**So zero arms were added, deliberately.** Adding any of them today ships a phone
button that writes stock or the ledger with no draft and no undo — the #2555
defect, reintroduced five more times. The unblocking work is backend
(a DRAFT state for delivery returns; `asDraft` honoured by the PI convert
handlers; line-level + draft-capable converters for the two consignment pairs),
and each is a judgement call for the owner rather than a provable defect.


---

## 6a. Every picker row shows its VARIANTS (owner rule, 2026-08-19)

*"只要有 variants 的，你就应该要显示 variants"*. A sofa model decomposes into
modules — `9028-1A(LHF)`, `9028-1A(RHF)`, `9028-1NA` — that share a name, so a
row printing only the name identifies nothing. Every line-picker in this module
therefore renders the shared `buildVariantSummary` string for its row.

Two things have to be true, and **only checking the first is how this defect
hides**: the component has to be on the row, AND the row's endpoint has to have
SELECTED `variants`. `<VariantDescription>` over a row whose read never selected
them renders empty and is indistinguishable from a missing component.

| Surface | How it renders the summary |
|---|---|
| The ten desktop `*From*.tsx` pickers | `vendor/scm/components/VariantDescription.tsx` |
| `MobileConvertWizard` (all four targets) | `variantLineOf()` → `buildVariantSummary`, one muted line under the name; omitted when empty (no `Standard` filler on a phone) |
| `SalesOrderNewFromProducts`, `SoFromProducts` | **Deliberately none.** These pick CATALOGUE SKUs, not document lines. A catalogue row has no per-line variants (`default_variants` is SKU-master admin data, `pages/scm-v2/products/VariantsTab.tsx`), and the SO line they create carries none either — so a summary here could only ever print `Standard`. |

The reads that feed them all select `variants` — `routes/delivery-orders-mfg.ts`
(`soDeliverableRemaining`), `lib/do-line-remaining.ts`,
`routes/mfg-purchase-orders.ts` (`/outstanding-so-items`),
`lib/outstanding-po-lines.ts`, `routes/consignment-notes.ts`,
`routes/consignment-returns.ts`, `routes/purchase-consignment-receives.ts`,
`routes/purchase-consignment-returns.ts`. **Adding a picker means checking its
read, not copying the JSX.**

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

## 8a. The right-click menu (owner ruling, 2026-08-21)

**His words:** 「我要做成 right click 的功能，就是可以 convert 等等。那一些 button
要做成 right click 的」 — he had right-clicked a Sales Order and got Chrome's own
menu.

**Why he got Chrome's.** `DataTable` takes `contextMenu` as an **opt-in** and
only four pages had opted in — Consignment Notes, Consignment Orders, Payment
Vouchers and the Delivery Planning board — none of them the five documents he
works in daily.

**Nothing new happens in a menu.** Every entry calls a handler the page already
had; `pages/scm-v2/row-menus.ts` decides only WHAT IS OFFERED and IN WHAT ORDER.
A menu that also invented behaviour would be one nobody could review against the
buttons it duplicates.

**The destination is guaranteed, not promised.** He asked directly whether a
right-click convert lands where the button lands. Every transfer entry is built
on `convertToLink(pair, keys)`, and `convertScope.test.tsx` walks the whole
source tree and FAILS on any site that hand-writes a query onto a convert path
(§4a). A menu entry structurally cannot go somewhere the button would not.

### The shape, on every list

```
open / edit / print …   what you do WITH this document, and with its chain
────────
transfer to …           what you make FROM it
────────
status changes          what you do TO it
────────
cancel                  destructive, alone, last, red
```

Assembled by `lib/rowMenu.ts`'s `buildRowMenu`, which drops empty groups so a
row that does not qualify never renders a stray separator.

**The first group is no longer three fixed entries** — since 2026-08-23 it is
Open, Edit, and one print entry per document the row can reach. §8b has the
whole of that.

### What each list offers, and what it deliberately does not

**All ten document lists carry a menu since 2026-08-22.** The owner asked for
the other five that day: 「为什么我的 Purchase Invoice 是没有的呢？」,
「By right 每一个 Transaction Record 应该都可以右键（Right click）Move to
Cancel，或者在 Draft 那边右键 Confirm 之类的。」 and 「只要有 Cancel /
On Hold 状态的，全部都可以右键 Cancel 或 On Hold。」

| list | open / edit / print | transfer | status | cancel |
|---|---|---|---|---|
| Sales Order | Open · Edit · Print | Delivery Order | Confirm · On Hold · Take Off Hold · Reopen | yes |
| Delivery Order | Open · Edit · Print | Sales Invoice · Delivery Return | Confirm (DRAFT only) | yes |
| Purchase Order | Open · Edit · Print | Goods Received | — | yes |
| GRN | Open · Edit · Print | Purchase Invoice · Purchase Return | Confirm (post) | yes |
| Sales Invoice | Open · Edit · Print | — (SO → SI does not exist, §4a) | Record payment | **none** |
| Purchase Invoice | Open · Edit · Print | — (end of the purchase chain) | Confirm (draft only) | yes |
| Purchase Return | Open · Edit · Print | — | Confirm (draft only) | yes |
| Delivery Return | Open · Edit · Print | — | **none** — no draft step to confirm | yes |
| Stock Transfer | Open · **Print** — no Edit | — | **none** — posted on create | yes (posted only) |
| Stock Take | Open · **Print** — no Edit | — | **none** — see below | yes (open only) |

**Every document in the system can be printed, since 2026-08-22.** (Two owner
quotes were cited here and have been removed — neither is in any message he sent
in the session that produced the change; see `docs/modules/stock-take.md` §7.)
The Stock Transfer and the Stock Take were the last two that could not — see the paragraph below for what changed. The invariant is held by
a test rather than by this table: *"every list offers Print, on every status
that document has"* in
`frontend/src/pages/scm-v2/row-menus-remaining-lists.test.ts`.

**The bottom five have no transfer row because there is nothing to transfer
to.** `CONVERT_LINKS` holds six pairs (§4a) and not one of them starts at a
Purchase Invoice, a Purchase Return, a Delivery Return, a Stock Transfer or a
Stock Take — these are the documents at the END of their chains.
`buildRowMenu` drops the empty group, so no stray separator renders.

**Only Confirm and Cancel are offered to a person on the bottom five.** A status
the SYSTEM decides is never in a menu, and neither is one that needs a figure
the row does not carry. So the Delivery Return's Inspected and Refunded, the
Purchase Return's Complete and the Purchase Invoice's Mark paid all stay on the
row drawer, beside the numbers that justify them. Same judgement the Sales
Order's block already records for READY_TO_SHIP and DELIVERED. Read
`document-status-vocabulary.md` for which stored word each document uses for
its confirm step — five different ones, all shown as **Confirmed**.

**The Stock Take gets no Confirm, and that one is a judgement rather than an
absence.** Posting a take writes an ADJUSTMENT movement per non-zero-variance
line, and `StockTakeDetail.tsx`'s confirmation shows the operator exactly what
he is about to book — counted, untouched, variance lines, net variance — before
he agrees. A list row carries none of those numbers, so posting stays on the
detail page. Cancel IS offered because it does the opposite: an OPEN take has
written no movement, so cancelling one moves no stock. The server draws the same
line — `/stock-takes/:id/cancel` accepts OPEN only, and undoing a POSTED take is
`/reverse`, a different route with its own words.

**The Stock Transfer and the Stock Take get Open, Print and Cancel — no Edit.**

> **CORRECTED 2026-08-22.** This paragraph read: *"No Edit and no Print, because
> there is nothing to call: `StockTransferDetail.tsx` is read-only ('no edits
> post-0078') and neither document has ever had a print handler on either
> surface."* The Edit half stands. The Print half was TRUE and was the gap, not
> the reason — these were the only two documents in the system that could not be
> printed at all, and the owner asked for it the same day.

The two generators are `frontend/src/vendor/scm/lib/stock-transfer-pdf.ts` and
`frontend/src/vendor/scm/lib/stock-take-pdf.ts`, built on the same
`pdf-common.ts` letterhead / table / footer every other document uses. Both open
`PrintPreviewModal` — never a straight download, and never `window.print()`,
which prints a blank sheet because `index.css`'s `@media print` block hides
`body *`.

**The menu entry navigates; it does not render.** `Print` goes to the detail
page with `?print=1`, which `useOpenPrintPreviewFromUrl` consumes — the same
contract the other eight lists' Print entries use. It could not work any other
way here: a Stock Transfer row carries the warehouse pair and a line COUNT, and
a Stock Take row a variance TOTAL. Neither carries the lines the sheet is made
of.

**Neither sheet states a value, and that is enforced.** Neither route carries
money of any kind — no unit price, no line total, no header total. So the Stock
Transfer's only total is **TOTAL QTY** and the Stock Take's is **NET VARIANCE**,
and `frontend/src/vendor/scm/lib/stock-movement-pdf.test.ts` asserts that
nothing drawn on either document reads as an RM figure.

**A BLIND stock take prints as a count sheet.** While a blind take is OPEN the
server strips `system_qty` and `variance` from the payload for anyone without
`scm.stock_take.supervise`, so the generator has nothing to leak: it drops both
columns and says why, rather than printing a rail of dashes that would read as
"no variance". No client-side flag decides this — the absent field does.

**Three of the five already HELD the cancel and could not reach it.** The Stock
Transfer and Stock Take lists each carried a `doCancel` — confirmation copy and
all — called from nowhere, and the Purchase Invoice list called
`useCancelPurchaseInvoice()` and used the result for nothing.
`frontend/tsconfig.app.json` sets `"noUnusedLocals": false`, so nothing said a
word. See `docs/bugs/0516-cancel-was-built-into-three-document-lists-and-reachable-fro.md`.

**Two entries are newly WIRED, both to endpoints that already had a caller.**
The Purchase Invoice's Confirm calls `/purchase-invoices/:id/post`, which its
own detail page's Post button calls; the Delivery Return's Cancel sends
`CANCELLED` through the status PATCH the list was already using for Inspected,
Refunded and Reopen. Nothing else in this change is new capability.

**On Hold is NOT in any of the bottom five yet.** Hold is being converted from a
status into a flag in separate work, and the hold entries land with it. Each of
the five factories carries a one-line note saying so.

**The Sales Order's status group closes the gap** recorded in
`sales-order.md` §0.1a: `IN_PRODUCTION`, `SHIPPED`, `INVOICED` and `ON_HOLD`
were accepted by the route and sent by no screen, which is why all four tabs
read zero. **`READY_TO_SHIP` and `DELIVERED` are deliberately absent** — both are
written by the machine, and a button whose effect a background sweep silently
undoes is worse than no button.

**The Delivery Order gained Cancel, a Delivery Return and Confirm on
2026-08-22 (owner ruling).** His words, looking at this menu: 「DO 这一边没有问
题，可是为什么没有 Cancel 呢？By right 每一个 Transaction Record 应该都可以右键
（Right click）Move to Cancel，或者在 Draft 那边右键 Confirm 之类的」 and 「我的
DO 也应该有右键 Transfer to Delivery Return，对吧？」

The paragraph this replaces said the DO deliberately offered neither, and its
argument was **the missing confirmation, not the entry**: cancelling a DO
reverses stock, and the list had no confirmation copy. So the entry ships WITH
one — `MfgDeliveryOrdersListV2`'s `doCancelDo` goes through `useConfirm` before
it writes, the same shape the Sales Order list's `doCancelSo` uses, and it posts
the DETAIL PAGE'S endpoint (`PATCH /delivery-orders-mfg/:id/status`, status
`CANCELLED`). No new capability; the menu offers the page's.

**What `canCancel` can and cannot see, said plainly.** The route refuses a
cancel on two grounds: the DO is already `CANCELLED` (`do_cancelled_final` —
un-cancelling would leave the stock add-back standing while the re-deduct
no-ops), and the DO has a live Sales Invoice or Delivery Return hanging off it
(`doHasDownstream`, `backend/src/scm/lib/downstream-lock.ts`). Only the first is
visible in a list row, so the second reaches the operator as the mutation's
error notice rather than as a missing entry. A refusal somebody reads beats a
capability that silently is not there.

**Only ONE status entry, and it is the DRAFT rung.** `Confirm` is
`doAdvanceStep`'s single step (DRAFT → DISPATCHED) — the handler the list
drawer already had. The rest of the ladder stays off the menu because the DO is
the document where a status move has a STOCK consequence: the first entry into a
shipped state writes the inventory OUT, and `DELIVERED` belongs to the driver's
Proof-of-Delivery screen, which closes it WITH a signature.

**Transfer to Delivery Return needed the DESTINATION built too.**
`/scm/delivery-returns/from-do` existed and read no scope parameter at all, so
the entry would have opened every returnable delivery in the company. The pair
is now `doToDr` in `CONVERT_LINKS` and the picker reads it with
`readConvertScope`, pre-ticking the scoped note — the same contract §4a pins,
and `convert-scope-pickers.test.tsx` now mounts this picker too.

**No cancel on the Sales Invoice** — still a recorded gap, not a decision. That
list has no cancel handler; cancelling lives on its detail page, and it reverses
revenue.

---

## 8b. Print, for the whole chain, from the row (owner ruling, 2026-08-22)

**His words**, looking at the Sales Order list beside the detail page's Print
PDF button:

> 「简单来说，正常我们 print PDF 都是点进去 print 的吧。那我要在这边 right
> click，可以点 print SalesOrder、print DO，这样的意思其实就是 print PDF」

and, asked whether he meant only the Sales Order:

> 「要的啊，我是要全部的 Transaction Flow 都要」

**What "Print" used to do, and why it was not this.** Every one of the ten lists
had `print: (r) => navigate('/scm/<doc>/<key>?print=1')` — it LEFT the list,
opened the document, and let the detail page open its own preview. That is a
shortcut for "click into it", which is the thing he is asking to avoid, and it
could only ever reach the row's OWN document.

**Now the row menu prints any document in that row's chain, in place.** From a
Sales Order row: the order, each of its delivery orders, each of its sales
invoices. From a Purchase Order row: the order, the Sales Order it is bound to,
each GRN it was received into. Nothing navigates.

### The mechanism, and what was rejected

`PrintChainProvider` mounts **`PrintPreviewModal`** — the ONE print dialog
(owner 2026-08-06, 「全部打印的时候都需要有这个」) — once in `Scm2990Shell`, beside
`useConfirm` / `useChoice` / `useNotify`, and hands every descendant an
imperative `usePrintDocument()`. The rejected alternative was keeping
`?print=1`; it is cheaper and it is the behaviour he asked to stop.

Two things made the provider the right shape rather than a modal per list:

- **A list prints any of nine documents, chosen at right-click time.**
  `usePrintPreview` + a mounted modal is right for a DETAIL page, which prints
  one document and knows which one.
- **It fits.** `MfgDeliveryOrdersListV2.tsx` sits at its file-size ceiling
  exactly (2004 of 2004, measured 2026-08-23) and `MfgSalesOrdersListV2.tsx` had
  three lines of headroom; `scripts/file-size-ceilings.json` may only ever FALL.
  A modal plus three handlers in each of ten lists does not fit. An imperative
  call costs each list one import.

**Print now still goes through the PDF (`action: 'print'`), never
`window.print()`.** The global `@media print` block in `index.css` hides
`body *` and reveals only `.org-print-area`, so `window.print()` from a list
prints a blank sheet — which the Delivery Order shipped once.

### An entry is built only where the row carries an ADDRESS

**This is the constraint the whole feature turns on.** A PDF is fetched by
address, and the addresses differ:

| document | detail route | keyed by |
|---|---|---|
| Sales Order | `GET /mfg-sales-orders/:docNo` | the document NUMBER |
| every other document | `GET /<resource>/:id` (`.eq('id', id)`) | a UUID |

So a row that carries a related document's NUMBER and no id knows the document
exists, can label it, and **cannot fetch it**. Those entries are not built — not
built and greyed out, not built at all, because `buildRowMenu` drops empty
groups and a menu line that 404s is worse than one that is not offered. Nothing
is fetched to BUILD a menu either: a round trip per row would cost more than the
navigation it replaces, and these lists page 50 rows at a time.

### What each row payload actually carries (measured 2026-08-23)

Read from the row types in each list page and the endpoint that fills them.
**Offered** means the row carries an address; **number only** means it carries
the number and no id, so no entry is built.

| list | offered | number only — NO entry | not carried at all |
|---|---|---|---|
| Sales Order | its DOs (`do_refs`), its SIs (`si_refs`) — both added 2026-08-23 | `do_nos` for a DO with no id, `converted_po_nos`, `source_po_union` | — |
| Delivery Order | its SO (`so_doc_no`) | `invoiced_si_nos`, `return_nos`, `source_pos`, `source_sos` | — |
| Sales Invoice | its SO (`so_doc_no`), its DO (`delivery_order_id` + `do_number`) | `source_pos` | — |
| Delivery Return | its SO (`so_doc_no`), its DO (`delivery_order_id` + `do_doc_no`) | — | — |
| Purchase Order | its bound SOs (`assigned_sos`), its GRNs (`transfer_to_grns`) | `delivered_dos`; a PRE-2026-07-31 bare-string GRN chip | its PIs |
| Goods Received | its PO (`purchase_order`), its bound SOs | `delivered_dos` | its PIs, its PRs |
| Purchase Invoice | its PO, its GRN, its bound SOs | `delivered_dos` | — |
| Purchase Return | its PO, its GRN | — | — |
| Stock Transfer | its own only — it has no chain | — | — |
| Stock Take | its own only — it has no chain | — | — |

**The two stock documents have no chain, and their Print still navigates.** They
gained a print of their own on 2026-08-22 (`vendor/scm/lib/stock-transfer-pdf.ts`
and `stock-take-pdf.ts`) and it opens the detail page's preview with `?print=1`.
That is left alone here for a reason worth stating rather than hiding: neither
document appears in `CONVERT_LINKS` or in `TRANSFER_DOC`, so a `PrintTarget` for
one would need a NEW word in the transfer vocabulary — for a document that takes
part in no transfer. Inventing that word is a decision, not a mechanical
extension, so their chain of one keeps the navigation until somebody makes it.

**Two links were closed at the SOURCE, not worked around.** The Sales Order list
already read `delivery_orders` and `sales_invoices` by `so_doc_no` — both for
`has_children` and the DO No. column. Adding `id` to a select already in flight
costs **no extra round trip**, which is why `do_refs` / `si_refs` exist rather
than a per-row lookup. `do_nos` is untouched: it feeds a DISPLAY column that must
still show a delivery carrying no id, and `so-delivery-order-nos.ts` states that
difference in the one place both views are built.

**The Delivery Order's own two downstream links are a SIZED, RECORDED GAP.**
`invoiced_si_nos` and `return_nos` are numbers with no id, so the DO row offers
its Sales Order and nothing after it. The fix is the identical one column on two
selects already in flight (`delivery-orders-mfg.ts`, the `sales_invoices` /
`delivery_returns` reads beside `has_children`), and `lib/downstream-doc-refs.ts`
already has the function that would consume it — `refsByParent`. It is NOT in
this change because that router is **5,625 lines against a 5,418 ceiling**
(measured 2026-08-23): `scripts/check-file-size.mjs` refuses ANY growth in it and
a ceiling may only fall, so the four lines belong in a change that shrinks the
file. Until then the menu offers no entry rather than one that 404s.

**An MRP allocation is not a link.** `assigned_sos` can be a live MRP projection
(`OriginAssignment.source === 'mrp'`) rather than anything stored, and reading
one as a binding is the 2026-07-29 incident. Only `'linked'` and `'delivered'`
build an entry; a row from a backend that does not send `source` at all builds
none, which is the stricter direction.

### One-to-many is listed, never collapsed

A part-delivered order has several delivery orders — that is why the DO No.
column returns a list at all — so **each one gets its own entry**, labelled with
its own number. Printing "the delivery order" of an order that has three is a
question the menu cannot answer for the operator.

Past `PRINT_CHAIN_MAX` (five per document type) the remainder becomes ONE entry
that **says how many are not listed** and opens the document:
`+3 more Delivery Order — Open to print`. A silent cap reads as "that's all of
them", which is the same lie as showing only the first.

### The words

`Print Delivery Order HC-DO-2608-003` — the document name comes from
`TRANSFER_DOC` in `frontend/src/vendor/shared/transfer-vocabulary.ts`, the one
home for those words (§10 and #2370). It is generated, never typed, so this is
not a thirteenth spelling.

### Where it lives

| file | what it decides |
|---|---|
| `frontend/src/lib/printChain.ts` | WHICH documents a row may print, per list |
| `frontend/src/lib/printDocumentPdf.ts` | type → detail endpoint → generator, and the DR mapping |
| `frontend/src/components/scm-v2/PrintChainProvider.tsx` | the one dialog, and `usePrintDocument()` |
| `frontend/src/pages/scm-v2/row-menus.ts` | `printEntries` — where they land in the menu |

`MfgSalesOrdersListV2`, `MfgDeliveryOrdersListV2` and `DeliveryReturnsListV2`
now read their batch-export bundles from `printDocumentPdf.ts` too, so the row
menu's print and the list's "Export PDF (N)" cannot drift apart.

**The `do` branch fetches a SECOND thing, and it is the only branch that does
(2026-08-26).** After reading the delivery order it calls `armDoScanToken`
(`frontend/src/vendor/scm/lib/do-scan-token-arm.ts`), which asks the authed
`GET /delivery-orders-mfg/:id/scan-token` for the 64-hex token the printed QR
encodes, and stamps it on the header as `scanToken`. It replaced `loadScanId`,
which carried the delivery order's row id — the QR pointed at
`/scm/do-load?id=…`, behind the staff sign-in, so the code printed for the
storekeeper and the driver showed them a login screen (`docs/bugs/0544`). It now
encodes `/d/<token>`, which opens with no login.

A FAILED MINT PRINTS THE DOCUMENT WITH NO QR — it never falls back to the old
authed link. A paper carrying a link only office staff can open is worse than a
paper carrying none, because the storekeeper finds out at the lorry. This is
also why the token is fetched HERE rather than at each print call site: the
three surfaces that print a delivery order all reach the QR through one helper,
so none of them has to remember to arm it. Details in
`docs/modules/delivery-order.md`.

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

  The rule landed on `DeliveryOrderDetailV2` and NOT on the delivery-order list
  drawer, where the two buttons stayed mutually exclusive in an `if / else-if`
  chain until 2026-08-18: a DISPATCHED delivery matched the `Mark signed` arm
  and returned, so the transfer was not disabled there — it was never rendered.
  Both surfaces now render them independently, `Mark signed` secondary for the
  pre-signed states and the transfer primary for every shipped one.

#### Which deliveries may be invoiced — one declaration, five states

`DO_SHIPPED_STATES` (`backend/src/scm/shared/do-shipped-states.ts`, mirrored to
`frontend/src/vendor/shared/do-shipped-states.ts` and pinned byte-identical by
`frontend/src/vendor/shared/do-shipped-states.canonical.test.ts`) is the system's
ONLY definition of "this
delivery has shipped and is billable": `DISPATCHED`, `IN_TRANSIT`, `SIGNED`,
`DELIVERED`, `INVOICED`. The first transition into any of them writes the
inventory OUT, so by then the goods have left. `LOADED` and `DRAFT` are
deliberately outside it.

Both desktop entry points to `Transfer to Sales Invoice` used to gate on a
hand-typed `["signed","delivered"]` instead — a third spelling, and the
narrowest of the three, while the server picker
(`resolveCandidateDoIds`, which admits everything except `CANCELLED` and
`DRAFT`), the mobile convert wizard, and `DeliveryOrderDetailV2`'s own line
edit-lock all used something correct.

**This is worth remembering as a MULTI-ORGANISATION defect, not a status
defect.** The predicate contains no company term and never did. It fired on one
organisation only because of DATA: 2990's source system had no "delivered" step
on delivery orders, so its imported deliveries sit at `DISPATCHED`, while the
AutoCount carry-overs on the HOUZS side were inserted with the literal
`'DELIVERED'`. Two organisations, one build, one set of permissions — and one of
them was told the transfer did not exist. The fix is the shared constant in both
places; flipping the statuses in the database would only have hidden it, and
`backfill-2990-delivered-dos.mjs` had already done exactly that for some of them
without the button appearing for the rest.

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

#### Five of the twenty have no button to relabel

Named so the next person adds them with the right label; **this is feature work
the owner has not commissioned, and Stage 1 did not build any of it.** From §2:

| missing | which half |
|---|---|
| Purchase Consignment Order → Receive | no "Transfer to" on the order |
| Purchase Consignment Receive → Return | no "Transfer to" on the receive |
| Goods Received → Purchase Return | no "Transfer from" picker page (`/scm/purchase-returns/from-grn` does not exist) |
| Sales Order → Purchase Order | no "Transfer to" on the SO list or SO detail — only PO-side `?edit=1` and the MRP page |
| Sales Order → Delivery Order (bulk) | exists only on the Delivery Planning board, not on the SO list |

**It was SIX until 2026-08-22.** *Delivery Order → Delivery Return* left this
list that day — the owner commissioned it («我的 DO 也应该有右键 Transfer to
Delivery Return，对吧？») and it shipped as a Delivery Order row-menu entry
labelled by the rule, `transferToLabel('dr')`. It is the only row that has ever
left; the other five are still uncommissioned.

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

1. ~~**`From SOs:` — it is not a label, it is a stored data contract.**~~
   **RULED ON AND SHIPPED, 2026-08-18 — see §10.** The owner was given the
   recommendation below verbatim and chose to unify anyway. The note now reads
   `Transfer from Sales Order: …`, generated by this rule; every reader accepts
   the legacy spellings permanently; the stored rows are migrated by a separate,
   reversible, owner-dispatched workflow. The original reasoning is kept because
   it is still the reason the change had to be done in that ORDER:

   > `mfg-purchase-orders.ts` WRITES the note into `purchase_orders.notes` at
   > raise time, and regexes parse it back. For POs with no per-line
   > `so_item_id` it is the **only** SO→PO linkage there is, so rewording it
   > silently drops that provenance from the Relationship Map, `po-so-coverage`
   > and the PO PDF for every row already in production.

   The count in that paragraph was also wrong — it said **three** regexes. There
   were **eight** readers; see §10.
2. ~~**Provenance COLUMNS and detail fields.**~~ **SHIPPED, 2026-08-18 — see
   §10.** §5(a) of the sibling survey ("one column, four labels") was the real
   defect and it is now closed: one generated title, `Transfer From (<DOC>)`.
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

## §10 One provenance vocabulary (2026-08-18)

Stage 2 of the naming rule. The owner ruled on the two items §9 left open and
chose to UNIFY both. Three surfaces now speak one vocabulary, generated from one
table.

### The note is a STORED DATA CONTRACT, not a label. Read this first.

`scm.purchase_orders.notes` carries a provenance record for POs raised by the
MRP shortage→PO convert. Those POs have **no per-line `so_item_id`**, so this
free-text note is the **only** stored record of which Sales Orders the PO was
bought for. It is parsed, not just displayed.

**Eight readers.** Teach one of them only the current wording and every PO
written under the old one resolves to no source orders at all — the Relationship
Map's Sales Order node and the printed PO's "Your Ref No." simply go blank. No
exception, no log. Total loss, silently.

| # | Reader | What breaks if it stops parsing |
|---|---|---|
| 1 | `backend/src/scm/routes/document-flow.ts` | the whole relationship graph's SO→PO edge |
| 2 | `backend/src/scm/routes/po-so-coverage.ts` (×2 callsites) | PO↔SO coverage, "bought for" |
| 3 | `frontend/src/pages/scm-v2/po-relationship-map.ts` | the PO Relationship Map's Sales Order node |
| 4 | `frontend/src/vendor/scm/lib/purchase-order-pdf.ts` | "Your Ref No." + the per-line "For SO" column on the PRINTED PO |
| 5 | `backend/scripts/lib/doc-ref-repair-core.mjs` | the 2990 doc-reference repair |
| 6 | `backend/scripts/backfill-po-so-item-links.mjs` | Tier 2/3 link stamping (SQL predicate **and** parser) |
| 7 | `backend/scripts/audit-mrp-pairing.mjs` | the pairing audit's note census (SQL predicate) |
| 8 | `backend/scripts/repair-2990-doc-refs.mjs` | the A1 note repair (SQL predicate) |

Readers 6–8 narrow to candidate rows **in SQL** (`notes ~* <pattern>`) before any
JS parser runs. A pattern that knows fewer labels than the parser does not error
— it makes the whole script report a clean pass over rows it never fetched. Build
it with `provenanceNoteSqlPattern()`; never type it out.

### One home

`backend/src/scm/shared/transfer-vocabulary.ts`, mirrored byte-identically to
`frontend/src/vendor/shared/transfer-vocabulary.ts` (the pair `check-shared-
mirrors.mjs` and `transfer-vocabulary.canonical.test.ts` referee), with a script
twin at `backend/scripts/lib/transfer-vocabulary.mjs` for the `.mjs` scripts,
which cannot import TypeScript. `convertScope.tsx` re-exports it and no longer
owns the words.

All three are held to ONE corpus file,
`backend/tests/fixtures/provenance-note-corpus.json`, read by both suites — so
"the parsers accept the same inputs" is a fact about that file, not a claim.

| Surface | Generated by | Reads |
|---|---|---|
| button | `transferToLabel` / `transferFromLabel` | "Transfer to Goods Received" |
| lineage column header | `transferFromColumnLabel` / `transferToColumnLabel` | "Transfer From (SO)" |
| stored provenance note | `provenanceNote` | `Transfer from Sales Order: SO-…, SO-…` |

The SHORT form is new; the rule had none, which is exactly why fifteen headers
had been hand-written. Abbreviating there does not contradict "full names on
buttons" — it obeys its stated reason, that abbreviations belong where they
identify a document NUMBER, and a lineage column is a column of document numbers.

### The legacy labels are permanent

`From SOs:` and `From SO:` stay in `PROVENANCE_NOTE_LABELS` forever, whether or
not the backfill has run. Rows written under them exist in production, and a
hand-edited note can still produce them.

### What was deliberately NOT renamed

Three columns still read **"Source PO"** — `SalesInvoicesListV2`,
`MfgDeliveryOrdersListV2`, `mobile/source-chips.tsx`. They name the PO the
**goods** came from, resolved from `batch_no` on the stock ledger, and can read
"STOCK ADJ". That is a fact about inventory, not a document transfer: a Sales
Invoice is never transferred *from* a Purchase Order. Titling them "Transfer From
(PO)" would assert a lineage that does not exist.

One real mislabel was fixed in passing: `PurchaseConsignmentReceives`'s
`source_po` column showed a purchase-order number under the same header as the
`pc_number` column two columns away, which shows a consignment-order number. One
title, two document types, one screen.

### The backfill — shipped, NOT run

`backend/scripts/relabel-provenance-notes.mjs` +
`.github/workflows/relabel-provenance-notes.yml`. Dry-run by default; the owner
dispatches the apply, and the apply additionally requires `CONFIRM` typed out in
full (`relabel provenance notes`) — `apply=1` is one character away from a dry
run and sits in a dropdown, so it is not on its own enough to rewrite stored
provenance. It counts by exact form per company first, refuses any row
whose doc numbers would change, writes a complete `{id, po_number, company_id,
before, after}` manifest as a 90-day artifact on every run, updates each row
`WHERE notes = <exact prior value>`, then **re-reads every touched row and
re-parses it** to prove the extracted doc numbers are unchanged. Idempotent.
`MODE=revert` restores from the manifest, and only where the row still holds
exactly what the migration wrote.


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

**§10 below is a different question again.** §1–§8 are the entry points and §9 is
the vocabulary; §10 is the model underneath — what stops the same goods being
transferred twice — with a comparison against SAP, NetSuite, Odoo, Business
Central and AutoCount.

---

# 10. The transfer MODEL — what records that a line has been consumed

> Written 2026-08-17 from a source read of `origin/main` @ `b4a44c1a6`, after the
> owner asked: *"你要检查一下我们所有系统的 Transfer To 和 Transfer From 的这些
> bug,还要查看一下正常大型 ERP 都是怎么去做的。然后我们就对照他们,把所有的东西都
> 完善掉,这样就不会有问题了(包括避免重复开单等问题)。"*
>
> §1–§8 above are about **entry points** — which screens offer a conversion —
> and §9 is about the **words** on those entry points. This section is about the
> **model underneath**: what stops the same goods being transferred twice.
> Different question, and the one that costs money when it is wrong. It is
> deliberately independent of §9: renaming "Convert to" to "Transfer to" changes
> no mechanism described here, and nothing here asks for a different word.
>
> Every claim is labelled **PROVEN** (a command was run, or the source says it
> in words), **LIKELY** (consistent with the evidence, not yet observed) or
> **UNKNOWN**. Vendor claims carry a URL or they say UNKNOWN.
>
> **This section proposes no build and changes no behaviour.** It is the model.

## 10.1 The question, stripped of vocabulary

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

## 10.2 What our nine once-only pairs actually do

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

> **Which source rows are IN the pool is a separate question from the ceiling
> over them** (2026-08-20). `do-line-remaining.ts` takes a REQUIRED
> `DoPendingBasis` — `'invoiceable'` for the DO→SI chain, `'delivered'` for
> DO→DR and the unbilled-money report — because a LOADED delivery may be
> invoiced but has not delivered anything. The ceiling test passes
> `'invoiceable'`. The write-path cap (`checkSiOverRemaining`) pins the same
> basis internally: a cap measuring a narrower pool than the gate offers would
> refuse `over_remaining` on an invoice that had just passed
> `siTransferRefusal`. See `docs/bugs/0480`.

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

**Edit-side re-point guard (GAP-2), rows 9 & 11 — closed 2026-08-20.** The
`Unlinked-line back door closed` column above is the CREATE / add-line half. A
second half of the same door is EDITING an already-saved unlinked line's
`item_code` to one the parent carries: the stored link stays NULL, so the cap
and recount (both gated on it) still miss the line. That edit half was closed on
the GRN, purchase-return, delivery-return and sales-invoice chains on 2026-08-17
by `unlinkedEditRefusal` (`scm/lib/unlinked-line-edit-guard.ts`), and is now
wired into both consignment return line-PATCH handlers too — chain
`'consignment-return'` (parent = the Consignment Note, codes via `cnItemCodesOf`)
in `consignment-returns.ts`, and chain `'purchase-consignment-return'` (parent =
the PC Receive, codes via `pcReceiveItemCodesOf`) in
`purchase-consignment-returns.ts`. Both refuse the not-on-parent -> on-parent
transition with 409 `unlinked_line_repoint`; an ad-hoc code, a linked line and a
code-untouched qty edit still pass; a failed parent read fails closed. The
CREATE half for these two consignment pairs stays open — they convert through the
plain `POST /`, so there is no single create handler to hang the insert guard on
(the nine-not-eleven finding below).

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

   > CORRECTED IN PART, 2026-08-21 (docs/bugs/0502): the purchase-consignment
   > LEDGER writes now carry the same database backstop their siblings had —
   > `uq_inv_mov_pc_receive_source` / `uq_inv_mov_pc_return_source` (mig 0321,
   > the 0279 v2 shape with `COALESCE(correction_seq,0)`), so a concurrent
   > double-post of a PC Receive / PC Return books its stock ONCE whatever the
   > route does, and `purchase-consignment-receives.ts` no longer discards the
   > resync result behind a bare catch — refusals ride the response as
   > `movementErrors`. The DOCUMENT-level non-idempotency above still stands.
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
   in §10.6 is not new engineering — it is one already-shipped file, applied
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
  database (§10.5).

## 10.3 How established ERPs do it

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
constraint there. **So we are not behind on question 3; we are level.** What §10.5
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
the wrong first step — see §10.5 Part 3.

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

## 10.4 The gap list, ranked by what can actually go wrong

Ranked by consequence, not by tidiness. "We use different words" is not on this
list.

### G1 — ~~GRN → PI is the one money chain with no unlinked-line guard~~ — CLOSED 2026-08-17

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

This was the top item because it is the AP twin of a defect the owner already
reported and paid to fix on three other chains, it is on the money path, and it
propagates into the book we reconcile against.

**CLOSED 2026-08-17**, and the closing took four fixes rather than one, because
the first version of the guard was correct on the RULE and short on its REACH. The
full account is in `docs/unlinked-line-duplicate-coe.md` §5a; in brief:

| what | where |
|---|---|
| the predicate — refuse only when the material is already on a receipt this invoice covers | `lib/return-unlinked-lines.ts` `findUnlinkedPiLines` |
| **all three** paths that can reach the shape, not two | `POST /`, `POST /:id/items`, **`PATCH /:id/items/:itemId`** (which rewrites `item_code` and left `grn_item_id` null, so the shape assembled in two legal steps) |
| **every** receipt the invoice covers, not the header ref | `coveredGrnIds`: header `grn_id` UNION the receipts behind the invoice's own linked lines. A PI is line-level multi-receipt (mig 0267), so a set of one let a SECONDARY note's material through |
| FAILS CLOSED | the guard's read binds its error; every call site answers 500 `unlinked_check_failed`. An empty parent-code set is an unconditional pass, so a swallowed error opened the door in silence |

`grep -ci unlinked backend/src/scm/routes/purchase-invoices.ts` now returns a
non-zero count, and `return-unlinked-lines.test.ts` proves the wiring per HANDLER
by slicing the router's own source — each slice bounded at both ends, because an
unbounded one can be satisfied by a different handler's guard.

**What is still open on this chain**, and it is the reason G5 below does not read
as fully closed: the identical edit-path gap remains on all five SIBLING chains
(`grns.ts`, `purchase-returns.ts`, `delivery-returns.ts`, `sales-invoices.ts` each
map an item code in a line PATCH whose handler calls no unlinked guard), and their
shared code readers still swallow their errors. Those chains move STOCK; this one
moved money, which is why only it was closed.

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
| a DRAFT downstream does **not** consume | SO → DO, PO → GRN, GRN → PI | **two documents for one line.** Both are keyed, both look valid, and the second is refused only at confirm/post — after the operator has done the work. `grns.ts` states the consequence as a feature: *"two drafts can coexist on one PO line"*. **On GRN → PI that refusal did not exist until 2026-08-17**: the comment in `purchase-invoices.ts` claimed the cap was "re-checked at confirm (recomputeGrnInvoiced clamps to qty_accepted)", and that function CLAMPS and never throws, so it refused nothing — two draft invoices for one receipt line both confirmed, both posted AP, and the clamp left `invoiced_qty` reading correct. `PATCH /:id/post` now calls `verifyGrnLinesNotOverInvoiced` with the draft being confirmed COUNTED, before the flip and again after. The two coexisting DRAFTS are still allowed, deliberately; only the second COMMIT is refused. |
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

### G5 — Five of the eleven chains close no unlinked-line back door, and two of those have no endpoint to close it on.

**PROVEN** (second enumeration block, §10.2). The SIX that close it are SO → DO,
DO → SI, DO → DR, PO → GRN, GRN → PR and — since 2026-08-17 — GRN → PI (G1). The
five that do not are all four consignment / purchase-consignment chains, plus
SO → PO. On the two consignment pairs this is structural: the conversion is an
ordinary `POST /`, so there is no conversion handler to gate. **SO → PO carries no
once-only guard by ruling** (owner 2026-08-17): PO is soft-bound and MRP is the
authority, and MRP has no "already converted" concept at all — a demand line is
covered because its PO sits in the supply pool, so re-running MRP after a partial
legitimately offers the remainder again. It is not a gap to close.

**And on all six that DO close it, the door is closed on the CREATE paths only —
except GRN → PI.** Each of `grns.ts`, `purchase-returns.ts`, `delivery-returns.ts`
and `sales-invoices.ts` maps an item code in a line PATCH whose handler calls no
unlinked guard, so the refused shape can be assembled in two legal steps: add a
line the parent does not contain, then edit its code to one the parent does. Only
the PI edit path is guarded, because only that chain bills money. This is the
highest-value item left on this list.

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
  CANCELLED filters in §10.2 are in application code, so changing one silently
  restates history.
- **A per-transfer quantity cannot be recovered.** A child line's own `qty` is
  what it holds *now*; if it was edited after creation, the quantity it
  originally drew is gone. This bounds what §10.5 can honestly backfill.

The system's current answer at document level is a **detector, not a
prevention**: `backend/scripts/check-duplicate-documents.mjs`, run by
`.github/workflows/duplicate-documents-check.yml`, is read-only and heuristic
(line-multiset match, counterparty, date window). It exists because of a real
pair — same supplier, same date, identical lines, one received and shipped and
one never executed, with the unexecuted twin inflating MRP supply. Useful, and
downstream of the problem.

## 10.5 The recommended target model for THIS system

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

**G1 is already closed by hand** (2026-08-17), so this Part now has one fewer
chain to build and one worked example to copy. Two lessons from doing it that this
plan did not contain, and both generalise to the other chains:

1. **The set of call sites is part of the rule.** Guarding the CREATE paths is not
   guarding the chain: the line PATCH rewrites the item code and leaves the link
   alone, so the refused shape assembles in two legal steps. Any per-chain rollout
   must enumerate every handler that can write the code column, not just the ones
   named "create" or "convert".
2. **The parent is a SET, not a ref.** A purchase invoice covers several receipts
   (mig 0267) and its header names only the first, so a guard fed the header ref
   is blind to the rest. The same is true of any chain whose header FK is
   documented as a "primary ref"; the authoritative parent set has to be derived
   from the child LINES.

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

**Be honest that this goes further than any vendor here does.** §10.3 establishes
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

The status filters in §10.2 should be a single SQL predicate that the trigger and
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

## 10.6 What NOT to adopt

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
    SAP defines it on the **item category**, not in copy control (§10.3) — so
    "put it in copy control" would have been the wrong shape as well as
    unnecessary.
  - **`Update document flow` as a per-pair switch.** SAP needs it because
    writing the successor's flow record is optional work; we need the link
    written every time, so a switch only adds a way to have half a graph.
  - **`Pos./neg. quantity` / `PLMIN` sign handling**, and **value-based
    transfer**. Our returns are their own documents with their own quantities,
    and we have no transfer-by-value flow at all. AutoCount's separate
    value-outstanding track (§10.7) is a reason to keep it that way.

  Take the *invariant* SAP encodes — per-item, quantity-conserving, exhausted
  when the referenced quantity is consumed. Leave the configurability.
- **A link row that carries an AMOUNT instead of a quantity.** NetSuite's
  `nexttransactionlinelink` carries `foreignamount` and no quantity column
  (PROVEN, §10.3), so quantity consumed still has to be read off the downstream
  line. If we ever build the table in §10.5, the quantity is the entire point of
  building it; copying NetSuite's column set would leave us with the cost and
  none of the benefit.
- **Odoo's asymmetry.** Odoo has a real join table on the sales-invoice hop and
  only a plain FK on the purchase-invoice hop (PROVEN, §10.3). That asymmetry is
  the shape our own system already has too much of; it is not a precedent to
  lean on.
- **AutoCount's Full Transfer semantics.** See §10.7 — this one is not merely
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

## 10.7 Does AutoCount constrain the answer? Yes, in two ways — one permissive, one prohibitive.

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
(§10.5), key it per **line pair with a quantity** — that is what `DocTransfer` +
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

## 10.8 What this section deliberately did not settle

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

## The transfer says at SAVE time what it could not carry (2026-08-20)

This document reaches AutoCount by **TRANSFER**, not by a create, and the
transfer route applies a **strictly narrower** set of header fields than an edit
does — `SalesHeader` / `PurchaseHeader` only, plus one extra assignment on each
purchase arm. So the account book can hold this document and still be missing
fields it has: until 2026-08-20 the conversion payload carried the ERP's number
and the account and nothing else, so every one of these landed under the DRAIN's
date with a blanked reference.

The payload now derives from `AcDownstreamSpec.facts` — the ONE description of
this document, projected onto the keys this route can apply — so a field added
there reaches the transfer with no further edit. What it still cannot carry, or
what the ERP has no value for, is **said on the save**: the create handler
returns `acNotSent` on its 201 and the New screen calls `notifyAcNotSent` before
navigating, exactly as the sales- and purchase-order creates do (#2499). The
problems carry `AC_SENT_INCOMPLETE`, not `AC_NOT_SENT`, and their title says the
document ARRIVED and part of it did not — the other wording would send someone
to raise it a second time into a book that already holds it. It never blocks.

Full reasoning, and the per-field table of what each conversion used to drop:
`docs/modules/autocount-writeback.md` §7c5.

### The Purchase Invoice's hold arrived late (2026-08-23)

Its row menu carried `// Hold follows` from the day it was written — the five
bare lists got their menus and the hold-as-a-flag change were built in parallel
and deliberately kept apart. The flag landed, `PATCH /purchase-invoices/:id/hold`
was mounted, the four lists that already had menus were wired, and this one was
not, because its menu did not exist yet when that change ran. Its **On Hold tab**
kept rendering the whole time.

`setHold` is a REQUIRED parameter on `purchaseInvoiceRowMenu`, so the next
document to grow a menu cannot repeat it silently — the compiler names the call
site. See `docs/bugs/0525-the-purchase-invoice-had-an-on-hold-tab-and-no-way-to-reach.md`.

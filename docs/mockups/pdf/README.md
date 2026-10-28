# PDF / Document Unification — Audit + Mockups

**APPROVED by the owner, 2026-07-22.** Nothing here has changed the live PDFs yet —
these are still static HTML mocks plus an audit of the real generators, and no
generator code has been touched. The approval unblocks that work; it is not
itself that work.

### Two things the implementer must not "fix"

**1. `SPECIAL` moves onto its own line, and changes colour.** In the live
generators `buildVariantSummary` returns ONE string with every segment joined by
` / ` — fabric, SEAT, LEG and `SPECIAL:` alike (`backend/src/scm/shared/variant-summary.ts`,
"All present segments joined with ` / `"). The mocks render it as a separate
`<span class="special">` in a distinct colour. That is a **deliberate change to
what customers see on every document**, questioned by the owner on 2026-07-22
("為什麼是這樣？那個special？") and then approved. It is not a mockup error; do
not collapse it back into the single string.

**2. The `Fabric:` prefix belongs only to supplier-facing documents.** PO / GRN /
PI pass `labelled: true`; SO / SI / DO do not, and print the bare fabric code.
The mocks are correct on this — `grn.html` and `purchase-order.html` carry the
prefix, `sales-order.html` does not. Keep that split.

### Still not drawn

Purchase Invoice, Delivery Return, Purchase Return, the Sofa Layout diagram, and
the 6 Consignment variants. §3 explains why (each is the same skeleton with a
different title, party label and column set). Of those, **Delivery Return and
Purchase Return are the two that leave the building** — a customer signs the DR
on collection, a supplier issues a credit note against the PR — so if any of the
remainder is worth drawing before implementation, it is those two.

---

## 1. The plain answer: are our PDFs unified today?

**Almost — 7 of the 8 real PDF generators already share ONE template. The Purchase
Order is the single exception.**

Every document PDF is produced by frontend jsPDF in
`frontend/src/vendor/scm/lib/`. There is **one shared template file**,
[`pdf-common.ts`](../../../frontend/src/vendor/scm/lib/pdf-common.ts), which owns the
company letterhead, the info-block, the signature boxes, the money/date/amount-in-words
formatters, the footer, and the CJK-font safety. (There is **no** server-side PDF — the
backend only references the frontend generator in comments; see
`backend/src/services/email.ts:514`.)

| # | Document | Generator file | Uses shared template? |
|---|----------|----------------|-----------------------|
| 1 | Sales Order | `sales-order-pdf.ts` | Yes (reference layout) |
| 2 | Delivery Order | `delivery-order-pdf.ts` | Yes |
| 3 | Goods Receipt Note (GRN) | `grn-pdf.ts` | Yes |
| 4 | Sales Invoice | `sales-invoice-pdf.ts` | Yes |
| 5 | Purchase Invoice | `purchase-invoice-pdf.ts` | Yes |
| 6 | Delivery Return | `delivery-return-pdf.ts` | Yes |
| 7 | Purchase Return | `purchase-return-pdf.ts` | Yes |
| 8 | **Purchase Order** | `purchase-order-pdf.ts` | **No — bespoke, AutoCount-style** |
| + | Sofa Layout (addendum diagram) | `sofa-layout-pdf.ts` | N/A — a picking diagram, not a standalone document |

**The 6 Consignment documents have NO generators of their own — they reuse the 8 above**,
so they inherit whatever the base document does (this is good — it means fewer templates to
unify, not more):

| Consignment document | Reuses generator | Detail page |
|----------------------|------------------|-------------|
| Consignment Note (out) | Delivery Order | `ConsignmentNoteDetail.tsx` |
| Consignment Order (out) | Sales Order | `ConsignmentOrderDetail.tsx` |
| Consignment Return (out) | Delivery Return | `ConsignmentReturnDetail.tsx` |
| Purchase Consignment Order | Purchase Order | `PurchaseConsignmentOrderDetail.tsx` |
| Purchase Consignment Receive | GRN | `PurchaseConsignmentReceiveDetail.tsx` |
| Purchase Consignment Return | Purchase Return | `PurchaseConsignmentReturnDetail.tsx` |

**Documents that produce NO PDF today** (so nothing to unify — flagged for completeness):

- **Payment Voucher** (`PaymentVoucherDetail.tsx`) — screen only, no print/PDF export.
- **Fair / Sales Report** (`FairReport.tsx`) — **CSV export only**, no PDF.
- **POD** (`MobilePOD.tsx`) — a mobile proof-of-delivery capture screen, not a printed doc.
- **Quote / Quotation** — does not exist in the repo.
- **Service / ASSR** — has data + workflow, but **no PDF/print generator** exists.

---

## 1B. Furniture-specific line detail — VERIFIED preserved

The owner's concern: the real documents show sofa / modular / WIP furniture detail that a
generic sample doesn't. Below is exactly how that detail renders today (traced in the real
generators, not guessed) and confirmation it survives the restyle. **Unification is
presentation-only — every furniture block is re-skinned in place, none is dropped.** The
updated mockups (`sales-order.html`, `purchase-order.html`, `delivery-order.html`, `grn.html`)
now show all of it with realistic Houzs lines: a modular **BOOQIT corner sofa** and an
**ARIANI Queen divan bedframe**.

| Furniture-specific block | Renders on | Source (verified) | Preserved in unified template? |
|---|---|---|---|
| **Category section rows** (SOFA / BEDFRAME / ACCESSORY / SERVICE) | Sales Order | `soLineGroupRank` + interleaved grey header rows — `sales-order-pdf.ts` | **YES** — grey section rows in `sales-order.html` |
| **Modular sofa = one row per module** (`1A(LHF)` / `CNR` / `2A(RHF)`), ordered left-to-right | SO · DO · GRN · PO | `orderSofaModuleRowsWithinBuilds` — `so-line-display.ts` | **YES** — one module row each, all four mockups |
| **Sofa seat-height / variant grid** (`fabric / SEAT 28" / LEG 4"`) | SO · DO (customer) · PO · GRN (supplier) | `buildVariantSummary` sofa branch — `variant-summary.ts` | **YES** — the teal `.spec` line on each sofa row |
| **Bedframe grid** (`fabric / DIVAN 10" + LEG 1" / GAP 14" / T.Heights 24"`) | SO · DO · PO · GRN | `buildVariantSummary` bedframe branch | **YES** — the ARIANI divan row |
| **Fabric code enrichment** — customer docs `internal (external) — description`; supplier docs `supplierColour (ourCode)` | customer vs supplier docs | `docVariantLine` vs `specsLine` — `supplier-doc-data.ts` | **YES** — SO/DO show `EZ-003 (KN390-1) — Easy Clean Velvet`; PO/GRN show `KN390-1 (EZ-003)` |
| **SPECIAL add-ons segment** (`SPECIAL: Extra Cushion + USB Console`) | all line docs | `buildVariantSummary` specials | **YES** — the brass `SPECIAL:` line |
| **WIP part labels** (module / part codes: `LHF` `RHF` `CNR` `NA`; `Divan` `Headboard`) | item-code suffix + description | module ids in `sofa-build.ts` | **YES** — shown as the SKU suffix + a teal WIP chip |
| **Dual code** (supplier code + our code) | GRN (two columns) · PO (supplier code + our model in Description) | `supplierCodeFor` / `specsLine` | **YES** — GRN's Supplier Code / Our Code columns; PO's bold supplier code + model |
| **Top-down SOFA LAYOUT schematic** (LHF/RHF + which way it faces the TV) | **Purchase Order only** | `drawSofaLayout` — `sofa-layout-pdf.ts` | **YES** — plan-view diagram in `purchase-order.html` |
| **Per-line Delivery date** (`Delivery: 22/08/2026`) | Purchase Order | `effectiveDelivery` — `purchase-order-pdf.ts` | **YES** — the muted `Delivery:` line |

**Nothing to flag as un-expressible.** Every furniture block above is already produced by, or
composed for, the shared building blocks in `pdf-common.ts` — which is why the 7 documents on
the shared template ALREADY render all of them. The only furniture-specific block that is
document-specific rather than shared is the **sofa layout schematic**, which is Purchase-Order-only
by design; the unified template keeps it exactly there (see `purchase-order.html`). Restyling
changes the frame around this detail, never the detail itself.

---

## 2. Audit matrix — document × design-element (how each renders today)

"Shared" = drawn by `pdf-common.ts`. "Bespoke" = the Purchase Order draws its own.

| Design element | SO · DO · GRN · SI · PI · DR · PR (the 7) | Purchase Order (the outlier) |
|----------------|-------------------------------------------|------------------------------|
| Header / letterhead | `drawHeader` — company block **top-left**, logo support | **Centered** AutoCount-style block |
| Doc title placement | **Right-aligned**, 14 pt | **Centered** title bar, 15 pt |
| Company name align | Left | Center |
| Page margin | **14 mm** | **10 mm** (tighter) |
| Divider under header | Grey hairline (`setDrawColor 180`) | **Solid black**, 0.4 mm |
| Party block | `drawInfoColumns` (label-gutter left + colon-aligned right) | Same `drawInfoColumns` (this part matches) |
| Line-item table theme | `striped` | **`plain`** |
| Table header row | **Dark fill** `[34,31,32]`, white text | **No fill** — ruled top/bottom lines only |
| Signature block | Shared `drawSignatureBoxes` (2 dashed boxes) | **Bespoke** inline signature lines |
| Page number | In the **footer** | In the **header** meta ("Page: 1 of N") |
| Footer line | `doc no · portal · date` | **`Page p of N · Generated <timestamp>`** |
| Amount in words | SO yes; SI/GRN/DO no | Yes |
| Currency format | `fmtRm` → `MYR 1,234.56` | Same |
| Date format | `fmtDocDate` → **DD/MM/YYYY** | Same |
| Paper / units | A4 portrait, mm | Same |

**Per-document content flex (this is by design and stays):**

- **Delivery Order** shows **no prices** — quantity + m³ only (Owner rule, 2026-06-26), plus
  Source-PO / Rack picking columns and a customer + driver signature.
- **GRN** adds **Recv / Acc / Rej** received-quantity columns, a dual-code note ("supplier
  code first, ours second"), and a warehouse + supplier-driver signature.
- **Sales Invoice** adds the full **Subtotal / Discount / Tax / Grand Total / Paid /
  Outstanding** block, a due date, and a payment-terms line.
- **Sales Order** adds a **deposit/collection schedule** table, amount-in-words, and full
  Terms & Conditions.
- **Purchase Order** shows **Supplier** (not customer), payment Terms (NET 30), and
  amount-in-words.

---

## 3. The mockups — one template, five documents

Self-contained static HTML, A4 print CSS, Houzs brand look (IBM Plex, teal `#16695f`),
realistic Malaysian furniture-trade sample data, RM currency, DD/MM/YYYY dates.

| File | Document | Shows the template flexing to… | Furniture detail shown |
|------|----------|--------------------------------|------------------------|
| [`sales-order.html`](./sales-order.html) | Sales Order | prices + discount, deposit schedule, amount-in-words, full T&C | SOFA/BEDFRAME/ACCESSORY section rows; modular BOOQIT sofa (3 module rows); seat-height + fabric grid; SPECIAL add-ons |
| [`delivery-order.html`](./delivery-order.html) | Delivery Order | **no prices** (qty + m³ + Source PO + Rack), customer/driver signature | same sofa modules + bedframe grid, quantity-only |
| [`grn.html`](./grn.html) | Goods Receipt Note | **Recv/Acc/Rej** columns, dual-code note | modules received with **dual Supplier/Our code**, supplier-leading fabric |
| [`sales-invoice.html`](./sales-invoice.html) | Sales Invoice | full totals + Paid/Outstanding, payment terms | (generic lines — invoice carries no sofa geometry; totals-focused) |
| [`purchase-order.html`](./purchase-order.html) | Purchase Order | supplier party, brought **onto** the shared template (decision doc — see §5) | modules + **top-down sofa layout schematic** (LHF/RHF + TV), per-line delivery dates |

The remaining documents (Purchase Invoice, Delivery Return, Purchase Return, and the 6
Consignment docs) **follow the same skeleton** — they are the same base generators with a
different title, party label, and column set, exactly as the five shown here.

**How to open:** double-click any `.html` file, or drag it into a browser. To preview the
printed result, use the browser's Print dialog (Ctrl/Cmd-P) — the on-screen "MOCKUP" banner is
hidden in print and the page prints as clean A4.

---

## 4. What CHANGES vs what STAYS THE SAME

### What CHANGES — presentation only

Purely how the documents *look*. One shared skeleton applied to every document:

- **Unified header** on every doc: brand logo + Houzs Century block top-left, doc title +
  number + date top-right, a teal rule underneath.
- **The Purchase Order stops being the odd one out** — it moves from the centered
  AutoCount-style letterhead + plain table onto the same left/right header + striped table as
  the other seven. **This is the only document whose look changes materially.** The other seven
  are already on the shared template; they gain only the light teal accent + IBM Plex polish.
- **One table style** everywhere: dark header row with a teal accent line, striped rows,
  right-aligned money/quantity columns in IBM Plex Mono.
- **One totals block, one signature block, one footer** style across all docs.
- **Brand fonts + a restrained teal accent** (title, section labels, grand-total row). Today's
  PDFs are pure black-and-white; the mockups introduce teal as a light accent only — still
  print-clean on a mono printer.

**Documents restyled:** Sales Order, Delivery Order, GRN, Sales Invoice, Purchase Invoice,
Delivery Return, Purchase Return, Purchase Order — and, automatically, the 6 Consignment docs
that reuse them. (Purchase Order is the only structural change; the rest are cosmetic polish.)

### What STAYS THE SAME — all data & business behaviour

Nothing functional changes. Specifically unchanged:

- **Document numbers** — SO/DO/GRN/INV/PO numbering, formats and sequences are untouched.
- **Every amount and calculation** — subtotals, discount, tax, totals, paid, outstanding,
  amount-in-words are the same values from the same server data.
- **Which fields each document shows** — the DO still shows no prices; the GRN still shows
  Recv/Acc/Rej; the SI still shows Paid/Outstanding. We are re-skinning the same fields, not
  adding, removing, or moving data between documents.
- **What triggers generation** — the same "Print / Export PDF" buttons on the same detail and
  list pages, single and combined (batch) exports alike.
- **The data source** — same API endpoints, same query payloads. No endpoint, no route, no
  permission, no migration is involved. This is a frontend styling change only.
- **The CJK-font safety, date format (DD/MM/YYYY), currency (RM), A4 paper** — all retained.
- **Filenames of downloaded PDFs** — unchanged.

In short: **the documents will look consistent and on-brand; every number, field, and button
behaves exactly as it does today.**

### One thing that IS deliberately deferred

Introducing the teal *accent colour* is a taste call. If preferred, the same unified skeleton
can ship in **pure black-and-white** (matching today's ink-only PDFs) — the layout unification
is independent of the colour. Say the word and the mockups drop to B&W.

---

## 5. The one document that needs a real decision — Purchase Order

The Purchase Order is bespoke **on purpose**: it mimics the AutoCount PO format (centered
letterhead, ruled plain table) that suppliers are used to receiving. Unifying it means the
outbound PO stops looking like AutoCount and starts looking like the rest of the Houzs docs.

- **Option A (recommended, shown in `purchase-order.html`):** bring the PO fully onto the
  shared template — one consistent look across every document.
- **Option B:** keep the PO's AutoCount-style letterhead for supplier familiarity, but adopt
  the shared fonts, table style, and footer so it's *closer* to the family without abandoning
  the format suppliers recognise.

This is the only judgement call in the unification. Everything else is a straightforward,
low-risk cosmetic pass.

---

*Audit reads the real generators at `frontend/src/vendor/scm/lib/*.ts` as of branch
`design/pdf-unification`. Mockups are illustrative; sample data is fictional.*

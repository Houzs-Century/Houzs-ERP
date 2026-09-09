# The transfer chain, both directions, measured against the live book

**The owner asked on 2026-09-09:** 「帮我检查我的 transaction flow 里面，例如 SO、
DO、PO、GR，它们之间的 transfer from 跟 transfer to 是否正确？从我的 AutoCount
Live 数据那边看是正确的吗？」 and 「既然它们是 transfer to 跟 transfer from，那它们
的文件应该是一样的，SKU 一样、内容也一样。」

Two questions: are the **links** right, and do the two ends of a link hold the
**same goods**.

**How this was measured.** Not from the committed snapshot and not from docs. The
AutoCount side was re-pulled from the live book on the day
(`export-ac-convert-edges.mjs`, `AED_HOUZS` over ZeroTier, read-only,
`exported_at=2026-09-09T00:28:53Z` — 13,384 SO headers, one more than the
previous cut, so the book had moved). The ERP side is prod, read-only DSN.
`check-ac-convert-symmetry.mjs`, exit 0. Full output in the PR.

---

## 1. Are the links right?

### Inside AutoCount — the book's own consistency

| question | answer |
| --- | --- |
| a child naming a parent that is not there | **3** of 144,700 linked child lines |
| a live child hanging off a CANCELLED parent | **0** |
| a parent whose counter exceeds what its children took | 196 document groups |

The 3 orphans, named:

- `PO-009968` lines 906815 / 906817 → `HC-SO-2608-001`. **The purchase order is
  cancelled.** Not a live link.
- `I-2410-0184` line 256862 `THL-7179` → `DO-002231`. `DO-002231` **does not
  exist in AutoCount**, while `DO-002230` and `DO-002232` both do. It is a hole
  in AutoCount's own numbering — a delivery order removed from the book, leaving
  an invoice line pointing at nothing. Dated 2024-10, and the ERP holds none of
  the three documents.

**The 196 over-claiming parents are the number that looks alarming and is not.**
Split by edge: SO→DO/IV 94, DO→IV 85, PO→GR 19, and **SO→PO 0 of 11,139 line
groups, GR→PI 0 of 5,350**. Every one of the 196 is a document that is
**AutoCount-only — 0 of them were imported into the ERP** (section 4d: SO 92/92
AutoCount-only, PO 19/19, DO 85/85). They are the book's own historical residue,
almost all pre-2026; the single one dated inside the go-live window,
`DO-011123` (2026-08-04, book says 16 transferred, invoices took 14), is also
not in the ERP.

Nothing in that population came across the cutover, and nothing the write-back
did created any of it.

### Inside the ERP

| edge | linked | orphan | no parent link |
| --- | ---: | ---: | ---: |
| PO line → SO line | 1011 | **0** | 339 |
| DO line → SO line | 881 | **0** | 8 |
| SI line → DO line | 186 | **0** | 0 |
| GRN line → PO line | 732 | **0** | 70 |
| PI line → GRN line | 96 | **0** | 62 |

**Zero orphans on every edge. Zero live children under a cancelled parent.**

The three stored counters that gate a conversion:

- `mfg_sales_order_items.po_qty_picked` — **0 of 15,240 live lines disagree.**
- `purchase_order_items.received_qty` — 123 of 1,350 read HIGH.
- `grn_items.invoiced_qty` — 55 of 802 read HIGH.

**Both of those last two are the migration decision, not drift, and this was
checked rather than assumed.** All 123 PO lines sit on migrated purchase orders
(`linked_ac_docno` set on 123/123) and **all 123 match AutoCount's own
`PODTL.TransferedQty` exactly — 0 disagree**. The quantity came across
faithfully; only the receipt DOCUMENT was never imported. The 55 GRN lines are
the same shape one step further on: 55/55 on migrated receipts, expected value 0
on every one, because purchase-invoice history was deliberately not migrated —
the decision already recorded in `docs/bugs/0728`.

### Does the ERP hold what the book records?

| edge | book → ERP | ERP → book |
| --- | --- | --- |
| PO ← SO | 517 / 522 — **5 missing** | 517 / 517 |
| DO ← SO | 184 / 186 — **2 missing** | 184 / 184 |
| IV ← DO | 48 / 48 | 48 / 48 |
| GR ← PO | 521 / 521 | 521 / 521 |
| PI ← GR (composed) | 448 / 448 | 448 / 448 |

**The backward direction is perfect on all five edges: not one link the ERP
asserts is absent from the book.** The ERP has invented nothing.

The 7 forward gaps are both already-named populations:

- **2 DO ← SO** — `DO-001800 ← SO-002281`, `DO-005583 ← SO-007435`. The shop
  delivered a SUBSTITUTE item, so there is no sales-order line to point at
  (`docs/bugs/0706`, owner-decision, still open).
- **5 PO ← SO** — all sofa. Covered in §2c below, because the cause is content,
  not linking.

---

## 2. Do the two ends hold the same goods?

**Where a link exists, the two ends never name a different product.**

| edge | linked rows | **name a DIFFERENT product** | dangling |
| --- | ---: | ---: | ---: |
| PO ← SO | 1183 | **0** | 0 |
| DO ← SO | 1053 | **0** | 0 |
| IV ← DO | 186 | **0** | 0 |
| GR ← PO | 856 | **0** | 0 |
| PI ← GR | 218 | **0** | 0 |

Sofa purchase lines specifically: 371 linked, **371 same item code, 0
different**.

Three things qualify that clean sheet.

### a. A sofa is deliberately NOT the same shape on both sides

AutoCount holds a sofa as ONE line (`THL-2379`, qty 1). The ERP holds one row per
compartment (`2379-1A(RHF)`, `2379-2A(LHF)`, …, qty 2). 455 sales-order and 125
purchase-order line keys are shared this way and **all 580 are that
decomposition** — proved, not assumed. This is by design; "same SKU, same
content" does not hold between the two systems for sofas, and should not.

19 of those were reported until today as *"a document carrying NO sofa at all …
none has a benign explanation"*. That was a defect in the checker, not in the
data — `docs/bugs/0734`, fixed in this PR.

### b. Inside AutoCount itself, 31 orders shipped a different item than was ordered

These balance exactly on quantity but not on item code, so the goods went out
under a different SKU. **6 of the 31 were imported into the ERP:**

| order | ordered | shipped |
| --- | --- | --- |
| `HC-SO-001319` | `HB109NL` ×2 | `HB109NL` ×1 + `AK-ULTIMATE MATT (Q)` ×1 |
| `HC-SO-002069` | `AK-SLEEP ESSENTIAL 7 HOLES` ×5 | ×4 + `AERO-MP (Q)` ×1 |
| `HC-SO-002281` | `AK- LTX CLS PIL` ×3, `NTYR-CS LTX PIL + CSC` ×3 | `HB109M-CC` ×3, `HB109NL` ×3 |
| `HC-SO-003186` | `AK- LTX CLS PIL` ×4, `NTYR-CS LTX PIL + CSC` ×4 | `HB109M-CC` ×4, `HB109NL` ×4 |
| `HC-SO-006438` | `AK-CS AIRLOFT COMFY PIL` ×2, `NTYR-CS LTX PIL + CSC` ×1 | ×1 + `HB109M-CC` ×1, `HB109NL` ×1 |
| `HC-SO-007435` | `AK-SK + MICROFIL PIL` ×2 | `AK-SK FX AIRLOFT PIL` ×2 |

`SO-002281` and `SO-007435` are the same two documents as the DO ← SO gap above —
one cause, two symptoms. This is history recorded in AutoCount before the
cutover; the ERP copied it faithfully. **Nothing to repair — an owner call on
whether any of it needs correcting in the book.**

### c. 6 sofa orders where the factory order and the sales order list different pieces

This is the one with a customer behind it. These are the 5 forward PO ← SO gaps
plus one more; the link is missing **because the content differs**, so no
matcher could pair them.

| purchase order | the sales order asks for | the purchase order asks the factory to build |
| --- | --- | --- |
| `HC-PO-009467` / `HC-SO-012128` (Lee, DELIVERED) | `9028-1A(LHF)`, `9028-1A(RHF)` | `9028-1S` |
| `HC-PO-009554` / `HC-SO-012729` (TAN SIN HUAT, DELIVERED) | `9058-2A(LHF)`, `9058-CNR`, `9058-1A(RHF)` | `9058-1S` |
| `HC-PO-009587` / `HC-SO-010209` (MRS YEOH, DELIVERED) | `9058-1A(LHF)`, `9058-1NA`, `9058-L(RHF)` | `9058-1S` |
| `HC-PO-009679` / `HC-SO-010955` (Ms. TEY HUEY NI, DELIVERED) | `9058-2A(LHF)`, `9058-CNR`, `9058-1A(RHF)` | `9058-1S` |
| `HC-PO-009830` / `HC-SO-011207` (Beh Zhe Quan, DELIVERED) | `9028-2A(LHF)`, `9028-L(RHF)` | `9028-1S` |
| `HC-PO-010085` / `HC-SO-010287` (Jack Lai, **IN_PRODUCTION**) | `9058-2A(LHF)`, `9058-1A(RHF)` | `9058-1A(LHF)`, `9058-2A(RHF)` |

**A bare seat code is NOT itself wrong** — 19 other purchase orders carry
`-1S`/`-2S` and link cleanly, because their sales order carries the same seat
line. The question is these six specifically, and it is a judgement call, so it
is asked rather than answered:

- On the first five, the sales order lists **arms and no seat**. A sofa of two
  arms and no seat is unlikely, so the more probable reading is that the SALES
  ORDER is the incomplete one and the factory order is right. All five are
  already DELIVERED, so this is a paperwork correction, not goods.
- `HC-PO-010085` is the live one. The sales order wants a **2-seat left arm and
  a 1-seat right arm**; the purchase order asks for a **1-seat LEFT and a 2-seat
  RIGHT**. That is the mirror image, and the order is still IN_PRODUCTION.

**Not in this list, and worth stating because it looked like one:**
`HC-PO-009024` / `HC-SO-012025` (WINNIE, IN_PRODUCTION). Its 3 unlinked lines
looked identical to the six above, but the two documents list **exactly the same
five pieces** (`9050-1A(LHF)`, `9050-1S`, `9050-1NA`, `9050-CNR`,
`9050-1A(RHF)`). That one is a pure linking gap, no content problem.

---

## What is left open

| # | item | whose call |
| --- | --- | --- |
| 1 | `HC-SO-010287` — arms mirrored between sales order and factory order, still IN_PRODUCTION | **owner, and time-sensitive** |
| 2 | 5 delivered sofa orders whose sales order lists no seat piece | owner |
| 3 | 6 migrated orders that shipped a different SKU than ordered (§2b) | owner |
| 4 | `docs/bugs/0706` — 2 substitute-item delivery orders | owner (already open) |

Nothing on this list is a defect in the transfer machinery. Items 1–2 are a
sofa-decomposition question, 3–4 are AutoCount history the migration copied
correctly.

**Ref.** Run of 2026-09-09 against the live `AED_HOUZS` book and prod. The
checker's own sofa-classification defect was found and fixed in the same pass
(`docs/bugs/0734`).

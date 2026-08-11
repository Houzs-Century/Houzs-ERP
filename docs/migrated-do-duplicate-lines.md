# The 18 duplicate delivery-order lines — one decision to make

**Date:** 2026-08-11
**Status:** writer FIXED and merged. The 18 rows already written are UNTOUCHED
and need one owner decision. Nothing here has moved stock.

---

## What happened

`create-migrated-documents.mjs`, the script that mirrored AutoCount's existing
paperwork into the ERP, inserted some delivery lines twice. Two mechanisms, both
now fixed:

1. it always attached an AutoCount delivery row to the **first** sales-order line
   of that item code, so a second row of the same code produced a second delivery
   line pointing at the same order line;
2. for a sofa it re-added **every compartment** of the build each time another
   AutoCount row named the same model.

## Exactly what exists now

**8 documents, 18 surplus lines, 14 duplicate groups. Every surplus line is an
exact duplicate of its twin — same item, same quantity, same sales-order line.
All are `migrated_no_stock = true` and there are ZERO inventory movements
against any of them.**

| Delivery order | Sales order | Item | Qty | Surplus |
|---|---|---|---|---|
| `HC-DO-004868` | `HC-SO-006089` | AKEMI ARMOUR MATT (K) | 1 | 1 |
| `HC-DO-004903` | `HC-SO-006438` | AK-CS AIRLOFT COMFY PIL | 1 | 1 |
| `HC-DO-005452` | `HC-SO-001920` | AK-COOL HUGGY BLANKET | 2 | 1 |
| `HC-DO-005452` | `HC-SO-001920` | AK-CS AIRLOFT COMFY PIL | 4 | 1 |
| `HC-DO-005452` | `HC-SO-001920` | AKEMI ARISTOI MATT (SK) | 1 | 1 |
| `HC-DO-005452` | `HC-SO-001920` | ELEPAHNE-(SK) | 1 | 1 |
| `HC-DO-005452` | `HC-SO-001920` | HB709M-CC | 2 | 1 |
| `HC-DO-005452` | `HC-SO-001920` | HB709NL | 2 | 1 |
| `HC-DO-006224` | `HC-SO-001920` | AKEMI ARISTOI MATT (SK) | 1 | 1 |
| `HC-DO-006224` | `HC-SO-001920` | ELEPAHNE-(SK) | 1 | 1 |
| `HC-DO-007525` | `HC-SO-006766` | STORAGE | 1 | **5** |
| `HC-DO-009013` | `HC-SO-010504` | NTYR-CL MX MICR PIL | 2 | 1 |
| `HC-DO-010008` | `HC-SO-005554` | STORAGE | 1 | 1 |
| `HC-DO-010222` | `HC-SO-009774` | AK-CS AIRLOFT COMFY PIL | 4 | 1 |

The exact row UUIDs to keep and to correct are printed by Actions -> **SO/PO
variant divergence diagnostic (read-only)**, Section D, under "EXACT
remediation list". They are deliberately not pasted here: re-read them at the
moment of acting, so nobody works from a stale list.

## What it costs today

No stock is wrong. What is wrong is the **order's arithmetic**:
`soDeliverableRemaining` derives remaining from non-cancelled delivery lines
linked by `so_item_id`, so a duplicate inflates "delivered" even with no
movement behind it. **11 sales-order lines currently read as over-delivered:**

```
HC-SO-001920 AKEMI ARISTOI MATT (SK)   ordered 1, delivered 4
HC-SO-001920 ELEPAHNE-(SK)             ordered 1, delivered 4
HC-SO-001920 AK-COOL HUGGY BLANKET     ordered 1, delivered 4
HC-SO-001920 AK-CS AIRLOFT COMFY PIL   ordered 2, delivered 8
HC-SO-001920 HB709M-CC                 ordered 1, delivered 4
HC-SO-001920 HB709NL                   ordered 1, delivered 4
HC-SO-005554 STORAGE                   ordered 1, delivered 2
HC-SO-006089 AKEMI ARMOUR MATT (K)     ordered 1, delivered 2
HC-SO-006766 STORAGE                   ordered 1, delivered 6
HC-SO-009774 AK-CS AIRLOFT COMFY PIL   ordered 2, delivered 8
HC-SO-010504 NTYR-CL MX MICR PIL       ordered 2, delivered 4
```

## Why they were not simply removed

The owner's rule is that nothing is deleted, only cancelled — and
**`scm.delivery_order_items` has no line-level cancel column.** Adding one is
not a small change: it is the same work as
`docs/autocount-line-retirement-plan.md`, deliberately deferred because a
half-converted soft-cancel is worse than the hard delete it replaces (a retained
`cancelled` row is only correct if every reader excludes it, and on the sales
side ~85 readers filter a flag that nothing has ever written).

## The two options

### Option A — add `cancelled` to `scm.delivery_order_items`, mirroring the SO pattern

Migration adds `cancelled boolean NOT NULL DEFAULT false`; the 18 rows are set
`true`; every reader is taught to exclude it.

- **For:** it is the owner's rule expressed exactly — the row survives, marked.
- **Against:** it opens the retirement work on a third table. The DO readers
  have never seen a cancelled line either, so the same audit
  `autocount-line-retirement-plan.md` did for sales orders has to be done here
  first — the delivered-quantity sums, the DO PDF, the returns chain, the
  invoice ceiling. That is a project, not a fix, and it is being deferred for
  reasons that have not changed.

### Option B — set the surplus lines to qty 0 with an audit note (RECOMMENDED)

Set `qty = 0` on the 18 surplus rows and write the reason into the line's
description or the document note.

- **For:** the row is **retained**, not deleted, so the owner's rule holds. It
  corrects the only thing that is actually wrong — the arithmetic — because
  every "delivered" sum is `SUM(qty)` and a zero contributes nothing. It needs
  no migration, no new column, and no reader changes, so it cannot destabilise
  a reader that has never met a cancelled line. It is reversible: the original
  quantity is recorded in the note and in this document.
- **Against:** a zero-quantity line still prints on a delivery document unless
  the PDF filters it, and "qty 0" carries less meaning than an explicit flag.
  The audit note is what supplies the meaning.

**Recommendation: Option B**, and revisit it only when the line-retirement work
lands for real — at which point the 18 zeroed rows can be flipped to
`cancelled = true` in one statement, because they are still there.

**Not recommended:** doing nothing. The 11 over-delivered lines are visible to
staff now and will be read as a stock problem, which is exactly the confusion
that cost a full day in `docs/unlinked-line-duplicate-coe.md`.

## Do not conflate this with the real second delivery

`HC-SO-001920` ordered ONE `ELEPAHNE-(SK)`. AutoCount's own `DO-006224`
genuinely delivered a second unit two months after `DO-005452`. Removing the 2
surplus ERP lines leaves **2 delivered against 1 ordered**, and that residue is
correct data: it is a commercial question about a real shipment, for the owner,
**not an ERP defect**. Do not "fix" it.

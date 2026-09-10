# HANDOFF — sofa alignment to the supplier listing, 2026-09-10

**Nothing in this round has been written to production.** Every run so far is
read-only. If you are picking this up, you are not inheriting a half-applied
repair.

## The owner's task list, in his order

1. Correct every PO **and GR** to match the supplier's listing — compartments
   AND variants. 「包过我的GR」.
2. Once those agree, re-check the **not-proceeded** orders against the photos.
3. Check every sales order against the TV rule (TV above / below the run).
4. When a PO or SO is confirmed correct, **back-fill the whole chain**
   SO -> PO -> GR -> DO.
5. **Tally** every sofa compartment and variant, to prove the round actually ran.

## The four rulings that govern this work

They are in the session memory too, but they belong here because they decide
what the scripts may do.

| ruling | his words | effect |
|---|---|---|
| the supplier is the authority | 「supplier的肯定对的 基本上你可以跟」 | correct OURS to match the file, without asking |
| **unless we amended it** | 「除非我们submit了amendment，然后还没发supplier PO amendment」 | a PO with an amendment raised after the supplier's cut is EXCLUDED — ours is newer. REQUESTED counts, not only APPROVED |
| a PO we cannot find is finished | 「找不到PO 可能已经送完了的 就不理」 | the 80 unmatched refs are old delivered orders, all below `PO-009122`. Not work |
| photos only for NOT-proceeded | 「你只需要看那些还没proceed的单就行了」 | a proceeded order's build comes back from the supplier. Proceeded = the SO has a Processing Date |

## What is measured, and what it says

All production runs, all read-only.

| question | answer | run |
|---|---|---|
| sofa SKUs whose NAME contradicts their CODE | **0 of 372** — the master is CLEAN | 34462427810 |
| sales-order sofa lines whose code and description disagree | **2 of 1,329**, both on HC-SO-012016 | 34462427810 |
| supplier vs our POs — different pieces | 13 | 34453751607 |
| supplier vs our POs — same pieces, different order | 24 | 34453751607 |
| supplier vs our POs — different variants (leg height) | 17 of 21 compared | 34453751607 |
| supplier refs with no PO here | 80 — all `PO-007914..PO-008700`, out of cutover scope | 34453751607 |
| sofa documents, company 1 | 529 (1,329 compartment lines) | 34451102468 |
| — proceeded (supplier answers these) | 168 | 34451102468 |
| — not proceeded, at risk, still to read | **179** | 34451102468 |

**Not yet measured:** the PURCHASE ORDER, GOODS RECEIPT and DELIVERY ORDER
sections of the code-vs-description census. The run died before them
(`docs/bugs/0785`); the fix is in `fix/sofa-code-desc-po-gr`.

## The tools, and what each is for

| script | workflow | state |
|---|---|---|
| `check-supplier-listing-vs-erp.mjs` | `check-supplier-listing-vs-erp.yml` | on main, RUN |
| `check-sofa-direction-backlog.mjs` | `check-sofa-direction-backlog.yml` | on main, RUN |
| `check-sofa-code-vs-description.mjs` | `check-sofa-code-vs-description.yml` | on main, run PARTIAL — fix in `fix/sofa-code-desc-po-gr` |
| `propose-supplier-sofa-corrections.mjs` | `propose-supplier-sofa-corrections.yml` | branch `feat/supplier-sofa-corrections`, NEVER RUN |
| `apply-sofa-compartment-corrections.mjs` | `apply-sofa-compartment-corrections.yml` | on main; the WRITER. Not run this round |
| `reverse-sofa-build-middle-2026-09-10.mjs` | same-named yml | on main, PLAN run only |

The supplier's export is committed at
`backend/scripts/data/supplier-so-detail-2026-09-10.json.gz` (1,628 rows, 975
documents) with the workbook's sha256 inside it.

## The intended write path, and why it is that one

**Do not write a second writer.** `apply-sofa-compartment-corrections.mjs`
already corrects the sales order and the purchase order TOGETHER, pairs rows by
code and UPDATEs in place so `purchase_order_items.so_item_id` survives, refuses
a build whose downstream moved real stock, holds the money still, and re-reads on
a fresh connection. `propose-supplier-sofa-corrections.mjs` exists to produce its
INPUT, not to replace it.

Sequence: propose (read-only, emits JSON) -> commit the JSON and add it to
`CORRECTION_FILES` in `scripts/lib/sofa-corrections-source.mjs` -> run the
applier in DRY-RUN -> apply.

## Open decisions that are the owner's, not yours

- **A build whose PO already RECEIVED stock.** The supplier says we ordered
  different pieces; changing `item_code` under received stock moves the lot off
  its product. The applier refuses this by its own rule. Apply everything else,
  then put that list in front of him with the quantity and money at stake.
- Whether to take a FRESH AutoCount balance cut before touching payments. The
  committed one is from 2026-09-08 08:02 and only ages.

## Assigned to someone else — do not fix these

The owner said 「这个我让别人fix」:

1. `backend/src/scm/lib/so-revision.ts:694` — `applySoAmendment` updates
   `item_code` and never `description`, so the name goes stale on an amended
   line. This is what HC-SO-012016 shows.
2. `backend/src/scm/lib/so-revision.ts:1386` — `reviseBoundPo` writes neither
   `item_code` nor `material_name`, so an amended sofa's PURCHASE ORDER keeps the
   old build entirely. This is the dangerous one; the factory reads the PO.

## Still untouched, from the wider list

- 179 not-proceeded sofa documents whose drawing has not been re-read
- `HC-SO-012025` corner — plan run, never applied
- 42 non-sofa + 21 sofa stock cells disagreeing on quantity (RM 7,686)
- `I-000213` invoice never created (RM 2,549)
- AutoCount payments taken since the cut, never brought in

## Corrections I issued this round, so nobody re-inherits them

- The four "double-posted" goods receipts were a FALSE POSITIVE
  (`docs/bugs/0780`). Nothing was double posted; those receipts carry the same
  product on several lines.
- The product master is NOT the root of the code/description mismatch. I said it
  was, before measuring. It is clean, 372 of 372.
- "The SKU is probably wrong" on HC-SO-012016 was wrong: the SKU is the NEW value
  from today's amendment, and the description is the stale one.

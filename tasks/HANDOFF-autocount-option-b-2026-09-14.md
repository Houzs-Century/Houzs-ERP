# Handoff: clearing the AutoCount write-back backlog (option B), 2026-09-14

The owner asked which documents do not reach AutoCount and how to handle them,
and chose **B: fix the source, then clear the backlog**. This file records the
state at about 16:40Z on 2026-09-14. Before trusting any count here, re-run the
health check: `Actions -> AutoCount write-back queue — health (read-only)`.

## Where it stands

At 16:30Z (health run 34868541342) there were **0 outstanding failures**. The
13:42Z run had 22 failed rows on 12 documents.

The documents still open are listed under *Waiting on a person* below. Some rows
in the health report are history, not open work: HC-DO-2609-019,
HC-DO-2609-020/-021/-022/-028 and HC-PO-2609-001 were refused under their row
id and have been sent since. The check matches arrival by number, so it cannot
tell.

## What was wrong, and what fixed it at the source

| ledger | what happened | PR |
| --- | --- | --- |
| 0897, 0898 | converted DO / GR lines kept no AutoCount key; the book's `DocTransfer` names them | #3863 stamp; #3865 drain, which does nothing until the office host is rebuilt |
| 0899 | one large phone photo refused a whole edit (host body limit 2 MiB) | #3866 |
| 0900 | a refused DO / GR edit was never sent again once keyed | #3868 |
| 0901 | Hookka bindings named no AutoCount item (owner: Hookka = Ohana) | #3870 (148 codes seeded) |
| 0902 | a line moved to a new DO stayed on the old one in the book, so it was delivered twice | #3872 |
| 0903 | POs raised from an SO kept swapped values (0889) and no keys | #3873 (PO stamp + `resend-ac-document-edits`) |
| 0904 | a rebuild that retired a line stored none of the new keys | #3874 |
| 0905 | the health check listed documents as keyless after they were keyed | #3875 |
| 0906 | a sofa whose armed end was typed out of place was refused | #3879 |
| 0907 | a rebuild refused to store keys where an item code repeats | #3880 |
| 0908 | receipt rows the book never had were reached by no tool | #3881 |
| 0909 | a sofa piece kept as its own book line was folded alone and refused | #3882 |

## Applied to production today (each verified; run ids are in the PRs)

- **Keys stamped:** 603 DO / GR keys from DocTransfer and 83 PO keys from the sales-line link.
- **Zeroed in the book:** DO-2609-044 line 929094, DO-2609-058 line 929248, DO-2609-039 line 928894. Afterwards SO-008447 line 585388 read TransferedQty 4 -> 2.
- **Rebuilt, with keys now matching the book:**
  - HC-SO-013209 and HC-SO-001463.
  - HC-PO-2609-036, -038, -064, -098 and HC-SO-2609-027, -055, -065, -071. On all eight, ERP rows = book lines and every key is distinct and present.
- **Transfers re-sent:** HC-DO-2609-103, and HC-GRN-2609-047, which arrived with one keyless row (see below).
- **Receipts:** HC-GRN-2609-060, -061, -062, -063, -064, -066, -067, -068 and -006 now carry the pillows and stool the book never had. Every ERP row is keyed and every book line is claimed.
- **Edits sent:**
  - Delivery orders: DO-2609-039, -019, -020, -021, -022, -028.
  - Receipt: GRN-2609-028.
  - Purchase orders: PO-2609-001, -009, -010, -020, -022, -027, -032, -034, -047, -055, -063, -068, -069, -072, -073, -080, -086, -088, -089, -090, and PO-006690.
  - Sales orders: SO-008447, SO-2609-063, SO-012388, SO-013496, SO-000814, SO-011831, SO-004928, SO-012736, SO-012025.
- **Book spot checks after the sends:**
  - HC-PO-2609-032: CROWN 2 -> 1, STAR-(SS) 1 -> 2, each with its own cost.
  - HC-PO-2609-063: 1A(RHF) 2 -> 1 at 910.00; pillow 1 -> 2 at 0.00.
  - HC-PO-2609-009 and -010 match the ERP.

## Waiting on a person

- **Office host rebuild.** Needs someone at the office on AnyDesk; the owner will say when, "this week". It turns on #3865 (conversions keyed as they drain) and anything else built into `AcSyncService.cs` since the last rebuild.
- **HC-SO-002861 / HC-PO-009827.** The book line is one DSL-8060 SOFA. The ERP split it into 8060 pieces plus an **8069-CNR**, which is likely a wrong model code (8060-CNR). If someone corrects that ERP row, `resend-ac-document-edits` should compose it. UNTESTED.
- **HC-GRN-2609-047.** It arrived at 16:20Z with one keyless row, because the drain still compares item codes until the host rebuild. The snapshot committed with this file includes it. Run the stamp: plan, then apply with the digest.
- **HC-GRN-2609-008.** The stamp reports it `ambiguous_in_book`: one purchase line feeds two book lines (DSL-SQUARE PILLOW x2 and x1).
- **HC-GRN-2609-057 vs HC-GRN-2609-012.** A JAGER-(Q) row and a HOK-1013 (Q) book line appear to be cross-assigned between the two receipts.
- **HC-SI-2609-001.** An edit was dropped because the invoice's conversion had not drained. `resend-ac-document-edits` does not take invoices.
- **Photographs over 2 MiB.** Four documents were sent without them: SO-013496, SO-012388, SO-2609-063, PO-2609-055. Reducing the images is not built.

## Customer receipts (OR): not built

The owner expects receipts to be part of the sync. He did not follow the start-date and bank-account questions (asked twice), so do not ask him accounting details again.

Agreed way:
- Build it with the switch OFF.
- Bank account follows the accountant's current practice: cash -> CASH, HLB -> HLBB, voucher -> VOUCHER RECEIVED, everything else -> MBB.
- Show him and the accountant sample ORs.
- The accountant picks the start date.

Measured 2026-09-14:
- The office keys ORs about six weeks late: June's in August, July's by 09-11.
- 117 payments have been typed into the ERP by staff since 2026-09-08, about RM 410k.

It needs a new host route, and therefore the office host rebuild.

## Tools added today

- `backend/scripts/retire-book-only-conversion-lines.mjs`: zero a DO / GR line the ERP removed (snapshot-based; plan / confirm / verify).
- `backend/scripts/resend-ac-document-edits.mjs`: send named SO / PO / DO / GR documents as they are now. The plan composes and rolls back.
- `requeue-keyed-conversion-edits.mjs` accepts `DOC_NOS`: named DO / GR documents, whether or not a refusal was recorded.
- `stamp-conversion-line-keys.mjs` has a PO lane; the exporter writes `qty`, `transferredOn` and the PO lane.
- `rebuild-ac-document.yml` shares one concurrency group, so a queued run cancels the earlier queued one. Dispatch runs one at a time.

## The delta sync dedicated 9 sales-order lines to purchase-order lines for a different product [high]

**Symptom.** The sofa document-chain audit reported SO -> PO `MISMATCH code 0`
at 11:54Z (run 34119014176) — the owner's specifically named worry, clean — and
`MISMATCH code 9` at 14:02Z (run 34130736979). Every one is a bedframe whose
sales-order line names a different bed from the purchase-order line now
dedicated to it:

| ERP sales order | its line | dedicated to PO line |
| --- | --- | --- |
| HC-SO-002558 | REGAL (A)-(K) | TRION (A) (HB STR)-(K) |
| HC-SO-002558 | FENRIR-(Q) | HILTON (A)-(Q) |
| HC-SO-009123 | TRION (A)-(K) | TRION (A) (HB STR)-(K) |
| HC-SO-010916 | BEDFRAME KIV | CELENE (A)-(K) |
| HC-SO-010916 | JAGER-(Q) | JAGER-(SS) |
| HC-SO-011752 | CODY-(Q) | JAGER-(Q) |
| HC-SO-012176 | TIFANNY-(K) | TIFANNY 2.0 (F)-(K) |
| HC-SO-013140 | BEDFRAME KIV | JAGER-(K) |
| HC-SO-013373 | JAGER-(Q) | DIVAN ONLY-(Q) |

**Root cause (traced).** `sync-ac-delta.mjs` section 4 (lane `links`) resolves
`PODTL.FromSODtlKey` to an ERP sales-order line and `PODTL.DtlKey` to an ERP
purchase-order line, both by `linked_ac_dtlkey`, and wrote `so_item_id` on the
strength of that key pair alone. It never compared the two rows' `item_code`.

Run 34123720786 (2026-09-07 12:46:40Z, `mode=apply
lanes=desc,pay,links,recv,do,dedi,hdr`) reported `SO->PO dedications written: 10
of 10 intended` and enumerated exactly these nine plus one accessory line
(HC-SO-011160 AMN-SOFA PILLOW). It is the only run between the two audits that
wrote a dedication.

**AutoCount is not the wrong side.** Decoding the 2026-09-07T09:35:24Z truth
snapshot, every one of those PO lines resolves through its own `FromSODtlKey` to
a sales-order line with a BYTE-IDENTICAL item code — `PO-010095` dtl 917739
`HOK-2008(A) (K)` -> `SO-002558` dtl 165874 `HOK-2008(A) (K)`, and so on for all
nine. `autocount-erp-mapping-1561.csv` then maps `HOK-2008(A) (K)` to
`TRION (A) (HB STR)-(K)`, `HOK-1013 (Q)` to `JAGER-(Q)`, `HOK-2038 (A) (K)` to
`CELENE (A)-(K)`. So the book and the mapping sheet BOTH agree with the ERP's
purchase-order line, and the disagreement is between our two rows — the sales
order line is the one that does not match its own AutoCount source.

**Why it is not cosmetic.** A bedframe or sofa line is hard-bound
(`isHardBoundLine`, `backend/src/scm/lib/so-stock-allocation.ts`): it reads READY
only through its OWN dedicated purchase order's `received_qty`. So HC-SO-002558's
REGAL (A)-(K) now goes READY when a TRION (A) (HB STR)-(K) is received, and the
real REGAL line can never light.

**Fix.** The `links` lane now refuses a dedication whose two ERP rows name
different item codes and prints each refusal with both codes, both DtlKeys and
the note that AutoCount's own pair agrees — so the next run reports nine
disagreements instead of writing nine links. `so_item_id` stays NULL until a
person decides which of the two rows is the faithful copy.

**NOT FIXED HERE: the nine dedications already in production.** Removing them is
a write to live rows and the underlying question — did the customer change the
bed, or did the sales-order import mis-map it? — is the owner's, not ours.
UNTESTED as a remedy: no revert has been written or run.

**Ref.** chore/golive-last-gaps-2026-09-07, 2026-09-07.

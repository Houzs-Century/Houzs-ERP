## the pointer stamp compared only the receipt list, so a purchase invoice raised after the last stamp never got a pointer [medium]

**Symptom.** The 2026-09-07 22:42 (UTC+8) reconcile — run 34134380843, from
`main` — reported `PI DOCUMENTS — in-scope AutoCount documents absent from the
ERP: 21 (GAP)`. Eighteen of the twenty it printed are recent invoices
(`PI-007941` … `PI-008025`) against purchase orders the ERP already holds and
has already been stamped with their AutoCount receipts.

**Root cause (traced).** `backend/scripts/stamp-ac-grn-refs.mjs` writes two
columns in one statement:

```sql
SET linked_ac_grn_docnos = <gr list>, linked_ac_pinv_docnos = <pi list>
```

but its idempotency skip consulted only the first of them:

```js
const already = (p.linked_ac_grn_docnos ?? []).slice().sort();
if (already.length === gr.length && already.every((v, i) => v === gr[i])) continue;
```

A purchase order whose receipts have not changed is therefore skipped whole, and
the invoice list is never written. That is not an edge case, it is the normal
life of a purchase order: AutoCount keeps raising purchase invoices against
receipts it delivered weeks ago, so the GR list goes quiet long before the PI
list does. The last stamp before the reconcile — run 34113197377, `mode=APPLY`,
2026-09-07 18:46 (UTC+8) — reported `imported POs: 575; to stamp: 60` against a
snapshot holding `318 POs / 214 GR docs / 186 PI docs`. The other 258 POs with a
receipt were skipped by that test, and any invoice raised against one of them
since its last stamp went with them.

Measured offline against the committed snapshot, `ac-gr-refs.json.gz` names 186
of the 192 in-scope purchase invoices, so all but six of them were sitting in a
file the job had already read.

**Why it matters beyond tidiness.** `check-ac-erp-reconcile.mjs:383` counts
`linked_ac_pinv_docnos` as PRESENCE. A pointer the stamp declined to write is
therefore reported as a missing document, and go-live triage spends its time on
a money gate that was never the reason.

**Fix.** The skip now compares BOTH lists, and the job reports how many purchase
orders it is stamping ONLY because the invoice list moved — the number the old
test used to swallow. `backend/scripts/diag-migrated-purchase-invoices.mjs` is
the check that can see it: it names, per absent invoice, whether the purchase
order's stored receipt list already equalled the snapshot's, which is the
fingerprint of this skip firing.

**Observed, against production.** Four runs, in order:

| run | time (+08) | output |
| --- | --- | --- |
| 34139368829 | 23:38 | diagnostic: `ABSENT: 21`; `stamp_skipped_the_po_its_receipts_were_unchanged: 16` |
| 34139512152 | 23:40 | stamp DRY-RUN: `to stamp: 73 (73 of them ONLY because the purchase-invoice list moved…)` |
| 34140454809 | 23:51 | stamp APPLY: `DONE. POs stamped: 73. No GRN was created and no stock moved` |
| 34140590449 | 23:53 | diagnostic: `ABSENT: 5` |
| 34140676108 | 23:54 | reconcile: `PI DOCUMENTS — in-scope AutoCount documents absent from the ERP: 5 (GAP)` |

Under the old test all 73 would have been skipped: every one of them had a
receipt list already equal to the snapshot's.

**What the fix does NOT do.** It writes the pointer, not the invoice. Those 16
AutoCount invoices are now named on their purchase order; they are still not
`scm.purchase_invoices` documents, and cannot be until the goods-receipt line
prices are carried — see `docs/migrated-invoices-2026-09-07.md` §3.

**Ref.** fix/ac-purchase-invoices, 2026-09-07. Code fix in PR #3105; the run
evidence above landed with the follow-up.

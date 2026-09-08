## A give-away line cannot be topped up onto a sofa order, because the sofa compartments carry no AutoCount line key [medium] — OPEN

**Symptom.** `HC-SO-012128` is short its 4 x `HOK-SQUARE PILLOW` at RM 0.00,
marked `FOR CONPESSANTION WRONG ITEM DELIVERY` — the customer is owed four
pillows for a wrong delivery and the ERP document does not say so. The owner's
rule is that the book's entitlement appears on our document even when no money
moves. `topup-ac-so-lines.mjs` was written for exactly this line and cannot
write it.

**Root cause (traced, run 34173141448, 2026-09-08, against a cut taken the same
morning).** The census reports:

```
UNJUDGEABLE HC-SO-012128 (AC SO-012128) — book 2 line(s) (1 at RM 0.00) vs ERP 2,
                                          2 of them with no AutoCount key
```

The book holds two lines: `HOK-5530 SOFA` (1EL+1ER) and the four pillows. The
ERP holds two rows, and both are the sofa's decomposed compartments — so the
counts match by coincidence and the document is not flagged SHORT. Both ERP rows
carry a NULL `linked_ac_dtlkey`, and the top-up is all-or-nothing per document
for a reason it paid for: a keyless ERP row might BE the book line you think is
missing, and its PO twin bought that rule with 183 near-duplicates.

The ordinary key backfill cannot reach these rows either. It matches on
(AutoCount DocNo + ERP item code), and a decomposed sofa's rows are spelled
`9028-1A(LHF)` and friends, never the collapsed `9028-1S` the mapping knows.
`backfill-ac-sofa-line-keys.mjs` exists for that and today keys NOTHING:
run 34163860885 reports `sofa builds 88 ... rows to key 0; no AutoCount line 50;
count mismatch 38` on the SO side, and 12 / 0 / 11 / 1 on the PO side.

**Not fixed here, and deliberately.** The two available shortcuts are both
refused. Relaxing the all-or-nothing rule to "unless the item codes make it
unambiguous" is unsafe on precisely this shape: the ERP spells a sofa by
compartment and the book spells it collapsed, so a naive item-code comparison
would call the SOFA line missing too and write a second one. Writing the pillow
row by hand bypasses a tool whose refusal is the thing keeping a live document
from gaining a duplicate. The remedy is upstream — give the sofa compartments
their DtlKey — and that is `backfill-ac-sofa-line-keys.mjs`'s own 88 unmatched
groups, which is a separate piece of work with an owner decision in it (50
groups have no AutoCount line for the model at all).

**What IS settled, so nobody re-derives it.** Zero-priced give-away lines are
NOT dropped as a class. Measured on the same run over the whole migrated
corpus — 14,041 book lines across 2,789 documents, 2,704 of them compared line
by line:

- 21 book lines have no ERP row, across 14 documents
- 18 of those are at RM 0.00 (9 units of goods); 3 are priced, RM 600.00 total
- not one is refused for being free. 13 refuse because the book line carries no
  item code and the description binds to no ERP product; 5 refuse because they
  are bedframe lines whose variant decoding belongs to the importer
- `HC-SO-004188`, previously believed short its `AK-ULTIMATE (Q)` and two
  `AK-SK + MICROFIL` pillows, is COMPARED and complete: every one of its four
  book DtlKeys is on an ERP row. That belief was stale
- 85 documents cannot be judged at all because an ERP line carries no AutoCount
  key, and 2 of those hold FEWER ERP rows than the book does — those two are the
  candidate misses hiding behind the missing keys

**Ref.** chore/cutover-recut-0908, 2026-09-08.

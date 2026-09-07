## A migrated delivery order that lost every line vanished with no number going down [high]

**Symptom.** Two AutoCount delivery notes that the cutover cut DOES carry —
DO-001800 and DO-005583, both in `data/ac-partial-dos.json.gz`, which holds 84
notes — are not in the ERP and never were. The run that was supposed to create
them printed `DO documents: 82; already mirrored: 82; to create: 0` and said
nothing else. Nowhere in that output does any number go from 84 to 82.

A second, quieter shape has the same cause: DO-001953 exists in the ERP with 2
of its 4 book lines, and the two it lost were its only lines carrying a
quantity — so `create-migrated-invoices.mjs` refuses its sales invoice as
`nothing_to_invoice` and I-2411-0323 is absent too. Same for DO-000097
(RM 50 short of I-000213) and DO-001604 (RM 150 short of I-2410-0192, the
dropped line being a codeless `* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE`).

**Root cause (traced).** `buildMigratedDoPlan` in
`backend/scripts/lib/migrated-do-writer.mjs` builds `byDo` by pushing an item
for every book line it can place. A note whose every line fails to place never
gets a `byDo` entry, so it is not created, not refused, and not counted — it is
absent from the denominator as well as the numerator. `create-migrated-documents.mjs`
then reports `byDo.size`, which is the count AFTER the loss.

Why these lines fail is not a bug in the matcher: AutoCount's delivery line
names an item the sales order does not carry. Measured live on 2026-09-07 (run
34129497431, DRY-RUN against prod): `AutoCount delivery lines against open
orders: 369; unmapped code 3; no ERP SO line 7`, with
`MISS SO-002281 wanted "HB109NL" (exact hits 0); that order's ERP lines: AKEMI
ARMOUR MATT (Q) | AK- LTX CLS PIL | NTYR-CS LTX PIL + CSC | AK-SK + MICROFIL PIL`.
The book agrees: SO-002281 carries `AK- LTX CLS PIL` (3 ordered, 3 transferred)
and `NTYR-CS LTX PIL + CSC` (3/3), and DO-001800 delivers `HB109NL` x3 "LATEX
PILLOW" and `HB109M-CC` x3 "COOL SILK LATEX PILLOW COVER" — a substitution at
dispatch. `DODTL` carries no from-LINE key in this book (`SoDtlKey` is null on
all 369 rows of the cut, and `export-ac-reconcile-truth.mjs` exports
`fromSoDtlKey` for `PODTL` only), so the item code is the only bridge and it
does not reach.

**Fix.** The matcher now attributes every drop to the delivery note it came
off (`stats.byDoc`: `bookLines` / `kept` / `dropped[{code, desc, qty, so, why}]`),
and `create-migrated-documents.mjs` prints two named lists — NOT CREATED AT ALL
(kept = 0) and CREATED SHORT — with the reason per line. The matching RULE is
deliberately unchanged: pairing `HB109NL` to `AK- LTX CLS PIL` on quantity is a
judgement about a substitution, and inventing that link would be computing, not
copying. What is fixed is that the run says so instead of being silent.

Pinned by two tests in `backend/tests/migratedDoWriter.test.mjs` — one for a
partial loss, one for `kept = 0`. Both were proved RED against the unfixed
`migrated-do-writer.mjs` (`stats.byDoc` was `undefined`, so both threw).

**Ref.** chore/golive-last-gaps-2026-09-07, 2026-09-07.

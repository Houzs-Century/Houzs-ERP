## A repair asserted the row shape it expected instead of the shape the data has [low]

**Symptom.** `align-last-three-cutover-docs.mjs`, first plan against production
(run 34344849256). One of the three was ready; the other two refused, and neither
refusal was a data problem:

```
── A HC-PO-006690 … -> zero every money column on 1 line(s) and roll the header to RM 0.00
── B HC-GR-005334: expected 2 keyed line(s), found 0 — REFUSED
── C HC-GR-005256-PO-009652: expected 1 line on DtlKey 906540, found 2 — REFUSED
```

A then ran and verified — `OK HC-PO-006690: 1 line(s) at RM 0.00, header RM 0.00`.

**Root cause (traced, not guessed), and it is two of the same mistake.**

**B looked the rows up by OUR document number.** The query joined
`g.grn_number = 'HC-GR-005334'`. A migrated receipt's ERP number is not always
the book's number with a prefix — several receipts in this very batch carry a
`-PO-NNNNNN` suffix, and `HC-GR-005256-PO-009652`, the neighbouring document in
the same list, is one of them. **The book's line KEY is the identity; the number
is a label.**

**C asked for exactly one row on a DtlKey.** A sofa is ONE line in the book and
one ERP row PER COMPARTMENT, every one carrying the same key. That is this repo's
own documented shape, in the purchase-order module guide, in the words *"indexed,
NOT unique — one AutoCount sofa line becomes one ERP line per compartment and
every one carries the same key"*, and in `sofa-is-one-book-line`. The script
asked for the shape a mattress line has.

**Fix.**

- B finds the rows by KEY across the company, PRINTS which document they landed
  on rather than assuming, and refuses if the two keys are not on the same one.
- C reads every compartment row on the key, refuses if the pieces disagree with
  each other — the rule its sibling `repair-so-variant-from-book.mjs` already
  states, that a scalar axis is written identically to every piece of a build —
  and writes the leg to all of them. The fresh-connection verification counts the
  pieces back.

Also: a re-run of A now reads `ALREADY the book's value, nothing to do` instead of
`somebody edited it since`, which is what a staleness gate should say once its
own write has landed.

**The lesson, and it is not "read the guide".** Both facts WERE written down, in
this repo, in files this session had already opened. The mistake was writing an
assertion of the shape I expected — `found 0`, `found 2` — instead of a query
that asks what shape is there and reports it. **A gate that states its
expectation and prints what it actually found turns a wrong assumption into a
refusal in one run**; both of these did, and nothing was written either time.

**Ref.** PR for `fix/last-three-bc-lookup`, 2026-09-09. Follows
`docs/bugs/0758`.

## Three cutover documents each had a purpose-built repair that could not reach them [low]

**Symptom.** After the sofa lane closed, the PO/GR tally stood at 1 purchase
order and 2 goods receipts differing from the account book, and every existing
repair reported nothing to do.

**What each one actually is.**

| | document | the difference |
|---|---|---|
| A | `PO-006690` | the book states ONE line, DtlKey 655505, `HOK-DIVAN ONLY (Q)`, qty 1, **no price**. We hold RM 380.00. |
| B | `GR-005334` | DtlKey 917594 — book `AKEMI IMMORTAL MATT (K)`, we hold ULTIMATE. DtlKey 917604 — book `AKEMI ULTIMATE MATT (K)`, we hold IMMORTAL. **Transposed, not missing.** |
| C | `GR-005256` | the receipt's leg is blank; the book says 1", and the purchase order now says 1" too. |

**Why the existing repairs could not do it — checked, not assumed.**

- `repair-migrated-grn-item-codes.mjs` **was run** (34342927182):
  `REPAIR — 0 line(s) would be rewritten; 59 already carry the ERP code`. It
  fixes an UNTRANSLATED book code; both codes on `GR-005334` are already real
  ERP codes, merely on each other's line.
- `repair-grn-variant-snapshot.mjs` restores a value that **could not have been a
  measurement**. A blank is absent, not impossible, so its gate 1 refuses.
- `repair-gr-money-from-book.mjs` is the RECEIPT side and its plan is 0;
  `PO-006690` is an ORDER.

Widening any of the three to reach one row would arm a sweep for a case nobody
has measured — the same reasoning as `docs/bugs/0756`. So this is the
reviewed-list shape instead: the population is typed into the script and anything
not matching what was reviewed is refused.

**On C specifically, because the instinct is wrong and the owner's was too.** He
said 「你这些需要再PO 处理然后convert就没问题了」 — fix it on the purchase order and
let the conversion carry it — and that is right for a receipt RAISED from a
purchase order. This receipt was not: `create-migrated-documents.mjs` wrote it,
copying the PO line's variants at the moment of migration, when the leg was
blank. **Correcting the PO cannot reach backwards into a snapshot.** The write is
safe anyway because it copies a value the book and the purchase order now BOTH
state, so nothing is invented.

**On A, said plainly because it is money.** A purchase order carrying no price is
the NORMAL shape in this book — 10,810 of 18,890 `PODTL` lines have none, because
Houzs prices a purchase on arrival. Clearing our 380 is a copy of that absence,
not a write-down, and the owner was asked in those terms before it ran.

**Fix.** `align-last-three-cutover-docs.mjs`, four gates: plan by default, a
confirm phrase, every row asserting what it currently holds before it is touched,
and a fresh-connection verification that asserts the codes, the leg, and the
money on both the line and the header. The swap is applied in ONE transaction —
half a swap is worse than neither half — and both receipts are asserted
`migrated_no_stock` with zero movements inside it.

### Two of the three refused on the FIRST plan, and both refusals were mine

A ran and verified — `OK HC-PO-006690: 1 line(s) at RM 0.00, header RM 0.00`.
B and C did not, and neither was a data problem:

```
HC-GR-005334: expected 2 keyed line(s), found 0 — REFUSED
HC-GR-005256-PO-009652: expected 1 line on DtlKey 906540, found 2 — REFUSED
```

**B looked the rows up by our DOCUMENT NUMBER.** A migrated receipt's ERP number
is not always the book's number with a prefix — several in this very batch carry
a `-PO-NNNNNN` suffix, `HC-GR-005256-PO-009652` among them. The book's line KEY
is the identity; the number is a label. It now finds the rows by key, prints
which document they landed on, and refuses if the two keys are not on the same
one.

**C asked for exactly one row on a DtlKey.** A sofa is one line in the book and
one ERP row PER COMPARTMENT, every one carrying the same key — this repo's own
documented shape, in the module guide, in the words *"indexed, NOT unique"*. It
now reads every piece, refuses if they disagree with each other, and writes the
leg to all of them, which is the rule the sibling repair already states: a scalar
axis is written identically to every piece of a build.

Both are the same error twice: **asserting the shape I expected instead of asking
what shape the data has.** The gates turned two wrong assumptions into two
refusals and no writes, which is what they are for.

**Ref.** PRs for `fix/cutover-last-three-to-book` and `fix/last-three-bc-lookup`,
2026-09-09.

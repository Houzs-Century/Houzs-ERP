## The top-up asked the catalogue with the unaliased sofa code, so four purchase orders were withheld on a settled question [high]

**Symptom.** `topup-ac-po-lines.mjs` reported `WITHHELD - the two importers'
item_group rules disagree about SOFA` for `PO-010085`, `PO-010086`, `PO-010160`
and `PO-010161`. Their sofa lines carry `HOK-5536 SOFA` and `HOK-5540 SOFA`, and
the two rules answered `sofa` (the mapping CSV) against `others` (the
catalogue). That was escalated to the owner as a decision to make. It was not a
decision — the answer was already in our own code, and the owner said so:
「为什么是其他呢 **5536 是 9058，5540 是 8030** 啊 … 你没看回去之前怎么做的吗」.

A sofa is not a label. It is decomposed into one ERP row per COMPARTMENT while
an "other" stays a single row, so the verdict decides the SHAPE of the document;
and a sofa reads READY only through its own dedicated purchase-order line, so a
withheld family leaves the customer leg of those four orders with no purchasing
line behind it.

**Root cause (traced).** `backend/scripts/topup-ac-po-lines.mjs`, in `resolveErp`:

```js
const fromCat = prodCat.get(norm(erp));          // erp === "5536-1S"
const ruleSoLinked = fromCat ?? "others";        // -> "others"
const sofaSplit = (ruleOutstanding === "sofa") !== (ruleSoLinked === "sofa");
```

The catalogue never says `others` about these sofas. It says NOTHING — it has
never carried a `5536-*` or `5540-*` row, because the ERP spells those models by
their alias (`lib/parse-sofa.mjs`: `SOFA_MODEL_ALIAS = { 5530: 9028, 5536: 9058,
5537: 8030, 5540: 8030 }`). The lookup was made with the code the mapping file
spells, unfolded, so it missed; the `?? "others"` underneath then turned that
silence into a confident category, and the refusal fired on a manufactured
disagreement.

**Both PO importers already fold, at exactly this point.**
`import-ac-outstanding-po.mjs` and `import-ac-so-linked-pos.mjs` each call
`aliasFoldsForCatalog(...)` on the mapping before the catalogue is consulted
(`lib/catalog-code-guard.mjs`, added by docs/bugs/0577). `topup-ac-po-lines.mjs`
was the one CSV item-code writer that never joined them — and it was left out
because the test that enforces the property iterated a list literally named
`IMPORTERS`, and this script is not an importer: it never creates a document.
The membership rule was the wrong one. The property belongs to anything that
resolves a book `ItemCode` through the mapping CSV and writes an `item_code`.

The same omission left the second half of docs/bugs/0577 open here too: this
script carries the silent fallback verbatim — `const code =
codeSet.has(ph.toUpperCase()) ? ph : r.erp` — with no catalog guard behind it,
so an unparseable sofa could have written `5536-1S` onto a document line.
`item_code` has no foreign key to `scm.mfg_products`, so nothing would have
refused it.

**Fix.**

1. The fold, applied where the mapping is READ, identically to both importers —
   only a code the catalogue LACKS is folded, and only onto one it HAS, so it
   can never move a code that already resolves.
2. The catalog guard (`nonCatalogRefs` + `formatNonCatalogRefusal` + a non-zero
   exit) placed before the dry-run return, so an operator learns the plan is
   unwritable while reading it rather than after typing CONFIRM.
3. `backend/tests/catalogCodeGuard.test.mjs`: `IMPORTERS` is renamed
   `CSV_ITEM_CODE_WRITERS` and gains this script, so the two properties are now
   enforced on all three writers. Run RED first — 2 failed / 19 passed, both
   failures on `topup-ac-po-lines.mjs` — then green at 21/21.
4. Four behavioural tests added beside them. The source-level tests prove the
   fold is CALLED; these prove what calling it CHANGES, since a fold applied
   after the catalogue had already been asked would satisfy the former and not
   the latter. They pin all four alias pairs, that `5535` is its own model and
   must never fold (owner ruling), and that the fold cannot quiet a genuine
   disagreement (`5543-1S` still splits).

**What this did NOT change.** The alias table itself, which was already single
homed in `lib/parse-sofa.mjs` and imported by 16 call sites — the drift was in
who APPLIED it, not in how many copies of it exist. The mapping CSV's four rows
still name the book model on purpose (`5536-1S`, not `9058-1S`);
`src/services/autocount-item-map.ts` is compiled from the same file and read in
the other direction, and repointing them was measured to write 192 of 697 corpus
lines back naming the wrong AutoCount item.

**Ref.** fix/sofa-alias-authority, 2026-09-08. Probe:
`probe-catalogue-alias-disagreement` (read-only, prod). Related: docs/bugs/0577
(the orphan code this class first produced), docs/bugs/0682 (the per-line SOFA
gate that created these seven partial documents in the first place).

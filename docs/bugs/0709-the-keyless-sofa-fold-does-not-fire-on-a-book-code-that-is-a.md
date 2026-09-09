## The keyless sofa fold does not fire on a book code that is a sofa without saying SOFA [low]

<!-- area: Sofa, fabric, variants -->
<!-- status: open -->

**Symptom.** `probe-gr-iv-pi-remainder.mjs`, run `34206144168` (2026-09-08 16:44
+08), after the fold was fixed twice (`docs/bugs/0707`). 28 of 29 unkeyed
goods-receipt pairs come back PROVEN identical. The 29th does not, and it comes
back with one side folded and the other not:

```
DIFFERS GR-000997|PO-001696 (ERP HC-GR-000997) — 1 of 1 rows unkeyed:
   2379-1S: the book has qty 1 at RM 1520.00; we have NO such line ;
   SOFA 2379: the book has no such item; ours has qty 1
      book: 2379-1S x1 @ RM 1520.00
      ours: SOFA 2379 x1 @ RM 0.00
```

One document, one line on each side, and the two sides are reported as two
different products because only OUR side folded.

**Root cause (traced).** `lib/keyless-multiset.mjs`'s `comparisonKey` decides
what a sofa is per side, and the two tests are not equivalent:

```js
const looksSofa = side === "book" ? isSofaCode(rawCode ?? code)
                                  : Boolean(suffixed) || isCompartmentCode(c);
```

`isSofaCode` is a `/SOFA/i` substring test over the BOOK's own untranslated
code. Every other sofa in this book carries it — the probe's own output shows
`9058-1S`, `8069-1S`, `8050-1S`, `8030-1S`, `5527-1S`, `9028-1S`, `3068-1S`,
`5119-1S`, `9050-1S` and `8051-1S` all folding correctly, because the raw code
behind each says `... SOFA` and the sheet translates it. **`2379-1S`'s raw code
does not**, so the book side stays a plain code while `isCompartmentCode` folds
our `2379-2S` to `SOFA 2379`. The comparison then has nothing to match.

**Not a wrong product, and NOT counted in the go-live remainder.** The reconcile
does not report this document at all: run `34206144168`'s sibling
`34202350017` puts GR item code at 0 and its own keyless section at *"2
document(s) ... 2 PROVEN identical"*, because `check-ac-erp-reconcile.mjs`
classifies it through `classifyItemCode`'s `decomposition` arm, which folds on
the MODEL and does not consult `isSofaCode` at all. Two modules, two definitions
of "this is a sofa", that agree on every other row the probe compared.

**LIKELY** — stated as LIKELY because it has not been settled against the book —
`-1S` is the book's marker for one whole sofa (it is what every other sofa line
in this snapshot uses) and `2379-2S` is our piece, so the document is identical
and the fold is the only thing wrong. **UNKNOWN** is whether `2379-1S` and
`2379-2S` are instead two genuinely different products; that needs the owner or
the slip, and it is one document.

**Fix.** NOT DONE, and deliberately not attempted from this lane: changing what
`comparisonKey` calls a sofa changes the keyless verdict for every document type
at once, and this is one row on one goods receipt that the reconcile already
declares. Recorded so the next person does not re-derive it. The shape of a fix
is to give the book branch the same model-based test the reconcile's
`classifyItemCode` uses rather than a substring over a name — one definition, not
two.

**Ref.** fix/gr-iv-pi-remainder, 2026-09-08.

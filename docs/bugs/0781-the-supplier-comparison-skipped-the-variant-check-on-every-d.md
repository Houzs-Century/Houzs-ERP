## The supplier comparison skipped the variant check on every document whose pieces differed [medium]

**Symptom.** `check-supplier-listing-vs-erp`, first production run (34453751607),
reported over 139 supplier documents:

```
agree on pieces, order and variants    4
DIFFERENT PIECES (what was ordered)    13
same pieces, DIFFERENT ORDER           24
same build, DIFFERENT VARIANTS         17
```

Read as written, 17 documents have a variant problem. The real denominator for
that 17 is **21**, not 139: the other 37 matched documents never had their
variants compared at all, and nothing in the output said so.

**Root cause (traced, in the script's own control flow).** The three findings
were written as a chain of early exits:

```js
if (bag(theirs) !== bag(mine)) { buckets.multiset.push(rec); continue; }
if (theirs.join('+') !== mine.join('+')) { buckets.sequence.push(rec); continue; }
// ... variants compared only here
```

so a document reported under DIFFERENT PIECES or DIFFERENT ORDER left the loop
before the variant block ran. The buckets read like a partition of the
population — one line each, all on the same denominator — and they are not: the
first two are exhaustive, the third is conditional on the first two passing.

A wrong leg height does not become irrelevant because the corner is also on the
wrong side. The two are separate repairs with separate risk: a leg height is a
`variants` jsonb edit that moves no stock, a piece is an `item_code` that may
already have been received against.

**Fix.** The three are computed independently and a document is reported under
every bucket that applies. Variants are still only compared where the pieces
match POSITIONALLY — that is the only case where line *i* on both sides is the
same piece, and comparing the wrong pair would be worse than not comparing —
but the documents deferred for that reason are now COUNTED AND NAMED
(`variants NOT compared (pieces differ)`) instead of silently dropping out.

**A second thing the same run could not answer.** 80 of 139 references landed
in `OUR PURCHASE ORDER NOT FOUND`, which reads like a broken link on more than
half the population. Every unmatched reference is in `PO-007914 .. PO-008700`
and every matched one is `PO-009122` or higher — the cutover's scope was
outstanding documents only, so an older, completed purchase order was never
taken. The report now prints the range of AutoCount purchase orders we actually
hold beside that bucket, so a reader can see the floor instead of inferring it.

**Lesson.** CLAUDE.md's *"ask what a successful result would ALSO be true of"*
applied to a count rather than a verdict. "17 documents have a variant problem"
is ALSO true when 37 were never examined. Any report whose buckets are printed
as one list on one denominator has to be a real partition, or say plainly which
lines share which denominator.

**Ref.** fix/supplier-variant-align, 2026-09-10.

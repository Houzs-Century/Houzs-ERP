## Two ways the sofa write-back could pick a different item for the same sofa [high]

Found while giving the four ambiguous sofa models a single canonical item. Both
are the same class: one fact derived in two places that were allowed to disagree.

**1. A compartment resolved differently from its own collapsed build.**
`resolveAcItemCode` had a fallback that sent a compartment (`9028-1A(LHF)`)
through the model base code, widening the candidate list with every AutoCount
model the cutover folded onto that ERP model (`SOFA_MODEL_ALIAS`). So a
compartment of 9028 saw `HOK-5530 SOFA` through the alias and took it on the
HOK preference, while `9028-1S` itself sees only the two brand items and falls
through. Resolving one line at a time and resolving the built document gave two
different AutoCount items for one sofa.

**Fix** - the SHAPE is now decided before the resolver runs, so the resolver
does no sofa reasoning at all: a folded line arrives as `<model>-1S`, an
unfolded one as its own compartment code, and each resolves to what it is. The
alias widening stays, restricted to base codes, which is the only shape it was
ever meaningful for.

**2. A run of ONE compartment stopped folding.** The new shape rule reads the
DtlKeys — compartments sharing one key are one line in the book and fold;
distinct keys are already separate lines and do not. A run of length one always
satisfies "all keys distinct", so every single-piece build silently stopped
folding. The visible damage was in the refusal tests: four of them went quiet,
passing lines through instead of refusing a bad Desc2, because a passthrough
line is never handed to the code that refuses.

**Fix** - the distinct-keys test requires at least two compartments.

**A third was caught in review before it shipped.** The first version of the
shape rule was "does the line have a key". A new order gets its keys back from
the create, so its very first edit would have folded two real account-book lines
into one. The owner spotted it: *"如果他有 delete 东西等等，就算是建立新的
order，他就会整个 SKU 换掉，不是吗？"*

**Lesson** - **when a pipeline decides a shape, nothing downstream may re-derive
it.** Every one of these came from the resolver holding its own opinion about
what a sofa is, alongside the collapse that had already decided. The fix that
actually holds is not a better opinion, it is deleting the second one.

**Ref** - `feat/ac-sofa-default-code`, 2026-08-13

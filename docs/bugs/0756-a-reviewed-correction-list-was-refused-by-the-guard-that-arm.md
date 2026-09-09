## A reviewed correction list was refused by the guard that arms the recompute sweeps [low]

**Symptom.** `repair-so-variant-from-book.mjs`, `MODE=apply` against production
(run 34338687918). The plan was clean — four lines, every one with the ERP blank —
and the write died:

```
PLAN: 4 line(s) would be corrected to the book; 6 skipped.
Error: purchase_order_items variant patch carries keys this writer does not own: legHeight.
Process completed with exit code 1.
```

**Nothing was written.** The guard threw before the statement.

**Root cause (traced, not guessed).** `assertOnlyOwnedKeys` refuses a patch
carrying a key the caller has not declared, and this caller passed
`OWNED_SOFA_KEYS`, which deliberately excludes `legHeight`. The exclusion is
correct and its own comment says why:

> `legHeight` IS A REAL SOFA AXIS, AND IT IS LEFT OUT ON PURPOSE … this is the
> FABRIC-LIBRARY sweep … Adding it here would make a colour sweep start writing
> heights.

That reasoning is about `refresh-po-variants.mjs` / `refresh-so-variants.mjs`,
which **recompute from Desc2 on every run**, so a key on their list is a key they
overwrite every time. It does not describe this caller.

**Fix.** `OWNED_BOOK_CORRECTION_KEYS` — the sofa list plus `legHeight` — and the
book correction passes that instead. The two lists stay separate on purpose,
because a SWEEP and a reviewed LIST are not the same kind of writer:

| | the refresh sweeps | the book correction |
|---|---|---|
| population | a query, every matching row | `data/variant-book-corrections.json`, entries a human reviewed one at a time |
| staleness | recomputes and overwrites | every entry states `erp_now` and is SKIPPED if the row no longer holds it |
| disagreement | flattens | refuses a build whose pieces disagree |

**Widening `OWNED_SOFA_KEYS` would have worked and been wrong**: it would arm the
sweeps to write heights, which is the exact thing that comment exists to prevent.
Four cases pinned in `tests/variantRefreshOwnedKeys.test.ts`, including that the
sweep list must NOT contain the leg and that the correction list carries no
bedframe axis and no `specials`.

**The pattern, which is the third instance today.** This is the third guard in
one afternoon that stopped a change I had only half-made — after the delivery
gate enforced in two places (`docs/bugs/0753`) and the plan-versus-result counter
(same entry). Each one refused loudly, wrote nothing, and named the thing it
wanted. **A repair script here is a stack of independent refusals, not a single
switch**; expect to satisfy every one of them and read each refusal as the next
instruction rather than as an obstacle.

**Ref.** PR for `fix/book-correction-owns-leg`, 2026-09-09. Follows
`docs/bugs/0755`.

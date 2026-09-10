## A sofa's colour landed on the first module only, so the corner and the two-seater have no fabric [medium]

**Symptom.** The owner, 2026-09-09, reading `HC-SO-010120` (`9058: 1A(LHF) + CNR
+ 2A(RHF)`): 「为什么这个 sales order 看起来并没有全部东西都一样啊？第一个 item 不
是应该跟第三、第四个 item 全部一样的吗？」 The first module shows
`HR805-31 / SEAT 30 / SPECIAL: …`; the other two show only `SEAT 30`.

Read on production (`diag-variant-fabric-code.mjs`, run 34373905203) — and the
account book is not the one that is wrong. Its `Desc2` is IDENTICAL on all three
rows, ending `colour : HR805-31`:

| row | item | what we stored |
|---|---|---|
| 1 | `9058-1A(LHF)` | `{colourId, fabricId, fabricCode: "HR805-31", colourLabel, fabricLabel, seatHeight: "30", specials: [5]}` |
| 3 | `9058-CNR` | `{"seatHeight":"30"}` |
| 4 | `9058-2A(RHF)` | `{"seatHeight":"30"}` |

**What it costs.** Two things, neither cosmetic. The factory sheet for the corner
and the two-seater carries no colour, so whoever builds them has to go and ask.
And stock buckets by `(warehouse_id, item_code, variant_key)`, so a corner asking
for `seatheight=30` cannot be filled from fabric-keyed stock of the very same
corner — the pieces of one sofa sit in different buckets and the set cannot be
allocated as a set.

**How many.** 31 sofas in company 1 have compartments that disagree on the
fabric, listed in full by the same run.

**Root cause — NOT ESTABLISHED, and I am not going to invent one.** The cutover
importer is not it: `import-ac-outstanding-so.mjs:271-282` loops
`for (const comp of ps.pieces)` and writes the SAME attribute bag — including
`fabricId`, `colourId`, `fabricCode`, `colourLabel`, `fabricLabel` — onto every
compartment, and its only other branch writes ONE placeholder row on the `-1S`
base code. Neither branch can produce this mix of a full bag on row 1 and
`{seatHeight}` alone on rows 3 and 4. So something else wrote these rows, and
which thing is still **UNKNOWN**. The repair below is safe without that answer
because it copies a value the book states for every row; the origin still has to
be found, or the same shape will keep arriving.

**Fix (the data).** `backend/scripts/fill-sofa-sibling-fabric-2026-09-09.mjs`
plus its `workflow_dispatch` workflow. A blank row is filled from its own sofa's
donor row ONLY where that sofa has exactly one non-blank fabric — the case where
the answer is forced. Plan by default, a confirm phrase on apply, every UPDATE
predicated on `coalesce(variants->>'fabricCode','') = ''`, and a fresh-connection
verification asserting the written value is a jsonb STRING (the double-encoding
COE is what a bare binding costs), that no row lost its seat height, and that
every line price and every order total is byte-identical.

**Two things it deliberately does not do.**

- A sofa with TWO different non-blank fabrics is left alone and listed.
  `parse-sofa.mjs` returns `perPieceColor`, so a two-tone build is a product we
  sell; "make them all the same" would destroy a correct order.
- SPECIALS are not copied. `mfg-pricing.ts` computes a `specialsSurchargeSen`
  per line, so writing five specials onto two more rows changes what a migrated
  order re-prices to. That is a money judgement and belongs to the owner, so the
  divergence is reported per document instead. The book states the specials once
  for the whole line, which is why they read as missing rather than absent.

**Ref.** fix/sofa-sibling-fabric, 2026-09-09.

## The cannot-be-compared list printed the refusal and never the build the ERP holds [medium]

**Symptom.** Three sales orders — `HC-SO-013495`, `HC-SO-013497`, `HC-SO-013503`,
all proceeded 2026-09-07 — were reported to the owner as having "no source at
all" for their sofa build, and he pushed back:

> 「所以基本上model和sofa compartment基本上都有了啊？那为什么你说没有呢？」

He was right. Two sources had been checked — the photograph (absent from
AutoCount) and the book's `Desc2` (finishing notes only) — and the third, THE
VALUE OUR OWN SYSTEM IS HOLDING, was never looked at.

**Root cause (traced).** Two places, and the report is the one that matters
because it repeats the mistake for every future reader.

`scripts/lib/variant-reconcile.mjs:421` computes the ERP's own piece list —
`const have = erpLines.map((l) => compartmentOf(l.item_code))`, then
`cell.erp = have.join("+")` — and it does this BEFORE the `UNREADABLE` branch,
so the value is sitting on the cell either way. The DIFFER branch in
`scripts/lib/variant-report.mjs` records `both`, which spells out
`AutoCount "…" vs ERP "…"`. The `UNREADABLE` branch beside it recorded
`cell.detail` alone — the REASON we could not check — and dropped `cell.erp` on
the floor.

`renderVerdict` in `scripts/lib/so-tally-verdict.mjs` then closed the loop: its
offender lists print `doc_no (ac_doc_no) — axes` and stop. `tallyVerdict`
already carried `detail` into `examples`; nothing printed it. So the artifact
the owner reads emitted exactly this and nothing more:

```
HC-SO-013503 (SO-013503)  [PROCEEDED] — sofa build not verifiable
```

A document the ERP may already hold a perfectly good build for is thereby handed
to him as a blank to fill from memory — 「把他已经答过的题目丢回给他」.

Note what would NOT have caught it: nothing was miscomputed and no rule was
wrong. `bucketOf` was right, the refusal was right, `cell.erp` was right. The
only defective artifact was **what got printed**, which is why this is a
reporting defect and not a comparison one.

**Fix.** `variant-report.mjs` now records `we hold "<cell.erp>" — <reason>` on
the unreadable branch, READING the value `variant-reconcile.mjs` already
computed rather than recomputing it, so there is still exactly one statement of
the build. `renderVerdict` prints the row's detail beneath each
cannot-be-compared entry — that list only, because a WORK row already names a
real difference on its axis while a refusal alone is the thing nobody can act
on. `bucketOf` and `isTallied` are untouched: this prints, it does not
reclassify.

Pinned by three cases in `tests/soTallyVerdict.test.mjs` — the build is printed,
`(nothing)` is printed when we hold nothing either, and the document stays in
CANNOT BE COMPARED. **Proved RED on the unfixed tree**: 2 failed / 23 passed,
the two failures being the missing `1A(LHF)+1NA+1A(RHF)` and the missing
`(nothing)`; 25/25 after.

`scripts/diag-so-erp-build.mjs` was added in the same lane — the read that
should have happened before anybody said "no source at all". It compares
nothing and imports `compartmentOf` from `variant-reconcile.mjs` rather than
restating it.

**Ref.** fix/so-erp-build-print, 2026-09-09.

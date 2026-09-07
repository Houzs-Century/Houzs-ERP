## The variant reconcile counted the owner's already-applied specials ruling as outstanding work [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On go-live day the SO variant backlog was quoted as **62 specials
DIFFER** and the PO side as **13** (reconcile runs 34127889821 and 34130727594,
identical). Read as a backlog, that says the special orders were not migrated.
A large part of it was work the owner had already DECIDED and that had already
been applied to production on 2026-09-04.

**Root cause (traced, not guessed).** `scripts/lib/variant-reconcile.mjs` built
the ERP side of the specials axis from exactly three places:

```
const vs  = asList((lead.variants || {}).specials);
const vs1 = asList((lead.variants || {}).special);
const cs  = asList(lead.custom_specials);
const carried = [...vs.list, ...vs1.list, ...cs.list]
```

There is a FOURTH place, and it exists precisely because the first one must not
be written. `record-priced-specials-on-migrated-lines.mjs` writes
`variants.specialsRecorded`, under the owner's ruling 甲 of 2026-09-03 —
「记下来给工厂看，但单据的钱不可以动」 — because ten call sites across nine files
fold `variants.specials` into a price or a cost, so stamping a PRICED code there
reprices a historical document. `src/scm/shared/variant-summary.ts` surfaces the
recorded key, so the factory does see the option.

The reader had never heard of that column. Confirmed by enumeration: the only
two files in the tree that mention `specialsRecorded` are the writer and the
summary — neither reconcile file does.

So a line whose priced option was recorded exactly as the owner instructed kept
reporting DIFFER, and the number reached him as outstanding migration work.

**Fix.** A `RECORDED` verdict with its own column in the table, and its own
sentence under it. It is deliberately **not** folded into `AGREE`: the line
genuinely does not tick the option, and calling that "agree" would be the same
dishonesty pointing the other way. `carried` is also left alone, so the reported
ERP value still says what the line actually holds.

The failure mode of the fix is pinned: **a PARTIAL cover stays DIFFER.** If any
option the book asks for is neither ticked nor recorded, the line is still a gap
— rounding a partial cover up to "decided" is exactly how a real gap would
disappear from a backlog.

Three tests in `scripts/lib/variant-reconcile.test.mjs`, proved RED first: with
the `RECORDED` export present and the old verdict block restored, 2 of 18 failed;
with the fix, 18 of 18 pass.

**The guard that caught this fix, and was right to.**
`backend/tests/specialsRecordedNeverPriced.test.ts` keeps `specialsRecorded` out
of every file that is not a display surface, because the whole reason the key
exists is that nothing which computes money may read it. It failed this change
on its first CI run, exactly as designed.

The four readers added to its allow-list are READ-ONLY reports — they open a
connection, SELECT, and print; none writes a line and none can reach a price.
The rule the list encodes is "render the key, do not price it", and a report is
a render. Nothing was loosened: the test's third case still asserts the four
pricing modules never mention the key, and `variant-reconcile.mjs` deliberately
keeps `specialsRecorded` OUT of `carried`, so a recorded option is never counted
as a ticked one.

**Ref.** fix/variants-specials-close, 2026-09-07.

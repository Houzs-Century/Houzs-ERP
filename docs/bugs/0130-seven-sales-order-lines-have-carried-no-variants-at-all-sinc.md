## Seven sales-order lines have carried no variants at all since August, and nothing counted them [high]

**Symptom** — seven `scm.mfg_sales_order_items` rows whose `variants` is a jsonb
ARRAY instead of an object. Every consumer reads `variants->>'fabricCode'` out of
an array as NULL, so those lines have no fabric, no seat height and no leg. Not
the wrong values — **absent** ones, on lines that decide what gets built and what
it costs.

**Root cause (traced, not guessed)** — the damage itself is
`docs/jsonb-double-encoding-coe.md`'s: a pre-serialized string bound to a jsonb
parameter, three times on 2026-08-10, turning a `variants || <fragment>` merge
into an array. The part worth recording here is **why it survived a month
unnoticed**: nothing counted the shape. It surfaced only because every apply in
the fabric family ends with `arrayShapeCheck`, and three separate production runs
on 2026-08-13 each closed with `SO: 7 variants block(s) of ARRAY shape`. The
count not moving between those runs is what proves those runs did not cause it,
and every repoint in `backend/scripts/lib/fabric-write.mjs` carries
`AND jsonb_typeof(i.variants) = 'object'` in its WHERE, so none of them could
have touched an array-shaped row in the first place.

**Fix** — `backend/scripts/repair-array-shaped-variants.mjs` +
`.github/workflows/repair-array-shaped-variants.yml`. `mode=plan` is the default
and prints every row's actual content; `mode=apply` requires
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"`, writes one row at a time and verifies on
a fresh connection that the recovered rows read back as objects with
`fabricCode` queryable again.

**What actually landed is not what the PR describes, and it took three more PRs
to work.** The PR's recoverable-shapes table lists `[ {...} ]` and `[ "{...}" ]`;
the production rows were neither — they are two-element arrays — so this version
recovered **zero of the seven** and #2100 had to widen it 92 minutes later. The
write it describes as *"the object is passed as TEXT and cast once with
`::jsonb`"* was in fact `$2::jsonb` with a JSON string bound, which is the
double-encoding again; #2118 fixed that after it had converted all seven rows to
jsonb strings on production. And the first plan run never reached a row at all
(#2098). The tool is right on `main` today; this PR alone was not.

**The class, for next time** — the detection was sound and the write-up was
written before the plan run that would have falsified it. `mode=plan` existed in
this very PR and prints exactly the shape that refutes its own recovery table.
When a repair ships with a dry-run, the dry-run's output belongs in the PR body
before the recovery rule is claimed to be complete.

**Ref** — 2026-08-13, PR #2096 (`fix/array-shaped-variants`). Entry written
2026-08-14 from the merged diff and from origin/main `de99056d5`. No module guide
covers `backend/scripts/`.

---

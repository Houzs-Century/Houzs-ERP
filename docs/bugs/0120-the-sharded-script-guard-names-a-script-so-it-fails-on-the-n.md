## The sharded-script guard names a script, so it fails on the next rename — third time in one day [medium]

**Symptom** - `npm run test:scale-contract` [gone] red on a branch whose only crime was
adding `--coverage` to the script CI shards. `pretest` gates `npm test`, and
`deploy.yml` runs `npm test -- --shard=...`, so a false failure here blocks the
backend deploy.

**Root cause (traced, not guessed)** - the guard exists to stop an `&&` chain
swallowing `--shard` (npm appends run args to the LAST command). It expressed
that by naming the script: first `assert.equal(pkg.scripts.test, "vitest run")`,
then — after #2131 split the suite and #2146 repaired the guard — `assert.equal(
pkg.scripts["test:workers"], "vitest run")`. Both are literals about a CARRIER
that keeps moving. Every rename that satisfied the rule perfectly was reported
as a violation: `test` -> `test:workers` (#2146), `test:workers` ->
`test:coverage:workers` (the coverage ratchet). Three false failures in one day,
each one able to block a deploy.

**Fix** - read the script name OUT of `ci.yml`'s shard line and assert THAT
script contains no `&&`. The invariant is now stated once, about whichever
carrier ci.yml actually uses, and the next rename needs no edit. Mutation-
verified: pointing ci.yml at `test` (the `&&` chain) fails with the offending
script printed; restoring it passes 83/83.

**Lesson** - a guard that pins a literal fails on the improvement it exists to
encourage. Derive the literal from the file you are guarding, and assert the
property. #2146 fixed the instance an hour earlier and the same shape came back
on the next PR — which is the definition of not having fixed the class.

**Ref** - 2026-08-14, alongside the coverage ratchet.

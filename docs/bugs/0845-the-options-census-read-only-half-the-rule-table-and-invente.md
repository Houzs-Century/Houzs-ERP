## The options census read only half the rule table and invented five unreachable codes [medium]

**Symptom.** `check-special-coverage-census.mjs`, on its first production run
(34704734640, 2026-09-13), reported:

```
   options NO TOOL CAN EVER FILL — a person has to pick them: 5
      Change 8030 Backcushion
      change to 5535 back cushion
      change to 9028 back cushion
      change to 9050 back cushion
      change to 9058 back cushion
```

That answer was going to the owner as the reply to 「还有什么 special?」. It is
wrong, and it would have sent him looking for a gap that does not exist.

**Root cause (traced).** `data/special-order-phrase-map.json` holds **two** rule
sources, not one. The census built its reachable set from `families` alone:

```js
const reachable = new Set(map.families.map((f) => K(f.code)));
```

but `mapPhrase` also consults `cushionSwapModels`
(`lib/special-order-phrase-mapper.mjs:82-93`), a table of
`[model, code]` pairs — `["8030","Change 8030 Backcushion"]` and four more —
that appear in NO family. Those five codes are reachable by every tool that uses
the mapper; the census simply could not see the table they live in.

**It was contradicted by evidence already on screen.** The apply run that
finished minutes earlier (34701789423) had written `Change 8030 Backcushion`
onto 23 lines, and the census's own carried-count column showed **124** document
lines holding it. A code that no tool can fill, filled by a tool, in the same
report. That contradiction is the finding — bridging it ("the 124 must be
hand-picked") would have been the wrong move, and is exactly what CLAUDE.md's
rule 2 forbids.

**Fix.** The reachable set is the union of both sources, and a self-test asserts
that a code only the SWAP table can produce reads as reachable, and that a name
no rule mentions does not. The census refuses to report if that fails.

**Corrected answer:** every one of this company's 35 catalogue options is
reachable by some rule. **There are ZERO options no tool can fill.**

**The lesson worth keeping.** This is the mirror of the trap this repo already
knows — "a checker that cannot match reports a clean run". A checker that does
not know about a rule source does the opposite: it **invents** a finding. Both
come from the same omission, so a checker must self-test that it can see every
input it claims to be complete over, in both directions.

**Ref.** chore/census-reads-both-rule-tables, 2026-09-13. Related:
`docs/bugs/0843` (the first half of the same map read wrongly),
`docs/bugs/0818` (a matcher that could not match).

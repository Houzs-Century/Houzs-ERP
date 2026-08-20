## The coverage ratchet cannot see the repo's `node:test` suites, so it reports well-tested modules as untested [medium]

**Symptom** — `coverage-ratchet` failed on this PR for three rounds with a
regression nobody caused:

```
FAIL backend/scripts/lib:
  - line coverage fell to 53.84% from a floor of 63.29% (1430/2656 lines).
  - 15 files have NO test executing them, up from 12.
```

**Root cause (traced, not guessed)** — the merged coverage report is produced by
**vitest only**: `backend`'s `test:coverage:light` + `test:coverage:workers`, and
`frontend`'s `test:coverage`. Vitest does not execute `node:test` files. This
repo keeps a whole second suite in that runner — `backend/tests/*.node.mjs`, run
in CI by `npm run test:scale-contract` [gone] and `npm run test:release-discipline` —
and a third in `vitest.pg.config.ts`, which declares no `coverage` block at all,
so `npm run test:pg` never emits a report.

On 2026-08-13 three new modules landed in `backend/scripts/lib`, each *with* a
thorough `node:test` suite that runs on every PR:

| module | lines | its test | measured by `node --test --experimental-test-coverage` |
| --- | ---: | --- | ---: |
| `release-discipline.mjs` | 231 | `tests/releaseDiscipline.test.mjs`, 43 cases | 98.60% lines |
| `jsonb-bind-scan.mjs` | 125 | `tests/jsonbBindScan.test.mjs` | 95.53% lines |
| `swallowed-read-scan.mjs` | 51 | `tests/swallowedReadScan.test.mjs` | 100.00% lines |

407 lines, all of them exercised in CI, all of them reported by the gate as zero
lines covered and three files with no test at all. The percentage did not fall
because coverage fell; it fell because the denominator grew by 407 lines the
instrument is blind to. Eleven of the fifteen files the gate names in this area
are the same artefact — the full list, with the runner that covers each, is in
`docs/TESTING-RATCHET.md` §6. Four genuinely have no test anywhere:
`sqlite-default-to-pg.mjs`, `scm-area-keys.mjs`, `bedframe-special-map.mjs`,
`classify-tests.mjs`.

**Fix** — the floors for `backend/scripts/lib` were re-baselined deliberately,
`--update --allow-drop`, to 53.74% / 15: that is what the instrument measures,
and pretending otherwise leaves a permanently red check that the next person
routes around. **The blind spot itself is NOT closed here.** Closing it is a
design choice with three real options, written out in `docs/TESTING-RATCHET.md`
§6 along with the one-line command that proves a module is covered
(`cd backend && node --experimental-test-coverage --test tests/*.node.mjs`) —
the smallest is a `testedElsewhere` list in `coverage-baseline.json` beside the
existing `knownAbsent`, each entry naming the harness, so "files with NO test"
means that again.

**Class** — same family as #2161 directly below: a gate whose *measurement* is
narrower than the property it claims to enforce. The two failure directions are
opposite and both cost. #2161's proxies were too narrow and let violations
through silently; this one's is too narrow and fails work that is correct, which
is the mode that gets a gate deleted. A ratchet that goes red on a PR whose
author did nothing wrong burns its own authority, and this one is not yet a
required check partly because of it. Expect a recurrence on the next
`scripts/lib` module that lands with a `node:test` suite.

**Ref** — #2143. Gate under test: itself.

=======

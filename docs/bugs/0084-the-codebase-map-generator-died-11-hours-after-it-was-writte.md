## The codebase-map generator died 11 hours after it was written, and froze the inventory for three weeks [medium]

**Symptom** - `docs/generated/codebase-map-facts.md` — the artifact
`CODEBASE-MAP.md` defers to precisely because generated numbers "cannot drift" —
claimed 122 route modules, 164 pg migrations and a highest migration of `0163`.
The tree held 135 route modules, 279 pg `.sql` files and `0281`. The file that
exists to be authoritative about migrations was missing 116 of them.

**Root cause (traced, not guessed)** - `gen-codebase-map.mjs:162` read
`backend/vitest.config.ts` by hardcoded name, to derive table 2's "read by
backend vitest" column. `#925` (2026-07-22 10:03) renamed that file to
`vitest.config.mts` as part of a toolchain upgrade. `#963` had written the
generator at 2026-07-21 22:28 — so it crashed with `ENOENT` from **eleven hours
and thirty-five minutes after it was born**, before writing any output. It had
produced exactly one generation, and that generation stood as current.

Nothing caught it because `audit:map` IS the same script with `--check`, so the
drift check crashed identically — and it is documented as deliberately NOT a CI
or deploy gate, for the good reason that a stale doc must never block a deploy.
The control case confirms the mechanism rather than contradicting it:
regenerating all three artifacts found `route-capability-matrix.csv` and its
summary byte-identical, because `audit:routes` gates them; the two that had
rotted, `codebase-map-facts.md` and `route-locator.md`, are exactly the two
nothing gates.

**Fix** - the generator resolves the vitest config across `.mts` / `.ts` / `.js`
and, if none exists, exits with a message naming the candidates instead of an
ENOENT stack — so the next rename says which filename to add rather than silently
freezing the inventory. Both stale artifacts regenerated. Class and lesson in
`docs/staging-bench-rot-coe.md`.

**Ref** - `docs/staging-truth-and-map-refresh`, 2026-08-12

---

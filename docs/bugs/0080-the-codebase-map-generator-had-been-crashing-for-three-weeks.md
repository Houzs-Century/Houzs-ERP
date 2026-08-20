## The codebase-map generator had been crashing for three weeks, so the map quietly rotted [medium]

**Symptom** - `docs/generated/codebase-map-facts.md` still claimed **122 route
modules** against a real 135, and **164 migrations / highest 0163** against a real
281 / 0281. Its own header says it is "regenerated from the tree so it cannot
drift", and `CODEBASE-MAP.md` points every new reader at it as the mechanical
layer that is safe to trust.

**Root cause (traced, not guessed)** - `gen-codebase-map.mjs:162` read
`backend/vitest.config.mts`. That file was renamed to **`vitest.config.mts`** by
#925 (the Vitest 4 / Vite 8 toolchain upgrade). Every run since has died before
writing a line:

```
Error: ENOENT: no such file or directory, open '...backend/vitest.config.mts'
    at read (backend/scripts/gen-codebase-map.mjs:50:13)
    at backend/scripts/gen-codebase-map.mjs:162:22
```

So this was never "nobody bothered to regenerate it". The generator threw, and
`audit:map` is **deliberately** not a CI or deploy gate (a stale doc must never
block a deploy - the sibling `audit:routes` gate jammed prod twice in one day).
Nothing was left to surface the crash, so the doc froze on 2026-07-21.

**Fix** - the config is located by trying `.mts` / `.ts` / `.js` in turn instead
of pinning one name, and throws a message naming the problem if none match.
Regenerating yields 135 route modules, 1038 endpoint registrations, 142 desktop
routes.

**Lesson** - **a generator that crashes is indistinguishable from a generator
nobody runs, and the artifact looks equally authoritative either way.** The
generated layer exists precisely so numbers cannot be wrong; that guarantee is
only as good as the generator still running. A doc-only generator should not gate
a deploy - but its failure has to reach somebody.

**Ref** - `fix/converter-hide-retired`, 2026-08-12

---

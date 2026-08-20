## Six source files were binary to git, so a production repair tool shipped with no reviewable diff [high]

**Symptom** — `gh pr diff 2082` showed `Binary files differ` for
`backend/scripts/merge-duplicate-fabric-colours.mjs`; the PR reported **0
additions** for it. That file is a 280-line tool that repoints fabric colours
across fifteen line tables and eight stock tables **on production**. It was
merged with nothing to read. `git grep` answers `Binary file matches` with no
content, so the file is also invisible to every audit that greps the tree — and
this repo audits by grep constantly (jsonb binds, swallowed reads, decision
params, company scope).

**Root cause** — a RAW NUL byte inside a template literal, used as a
composite-key separator:

```
const k = `${r.fabric_id}<NUL>${canonId(p)}`;      // the byte itself
const k = `${r.fabric_id}\0${canonId(p)}`;         // the escape — same value
```

NUL as a key separator is a fine technique. Writing it as the byte instead of
the two-character escape is what makes git classify the blob as binary. Both
spell the same string at runtime; only one is reviewable.

**Measured, not assumed.** Appending one line to the file gave
`git diff --numstat` → `-  -`. After the fix, the same appended line gave
`2  0`.

**The class was six files, not one.** Found by the gate written for the first
one, on its first run:

| file | NULs |
|---|---|
| `backend/scripts/merge-duplicate-fabric-colours.mjs` | 1 |
| `backend/scripts/probe-write-persistence.mjs` | 2 |
| `backend/scripts/seed-owner-fabric-catalogue.mjs` | 3 |
| `backend/src/scm/lib/size-variant-description.ts` | 1 |
| `frontend/src/pages/scm-v2/SalesOrderMaintenance.tsx` | 2 |
| `frontend/src/vendor/scm/lib/propose-days.ts` | 1 |

Every one is the same composite-key pattern, and three of them are live
application source, not scripts — a 76 KB sales-order maintenance page among
them, whose diffs nobody could read either.

**Fix** — all ten bytes replaced with `\0`. Both typechecks pass
(`npm run typecheck`, which in the frontend is `tsc -b`; `npx tsc --noEmit`
there resolves zero inputs and would have proved nothing).

**The check** — `backend/tests/noNulBytesInSource.test.mjs`, in
`npm run test:scale-contract` [gone]. It walks `git ls-files`, refuses to pass if the
listing returns implausibly few files, and fails on any tracked source file
carrying a NUL.

**Class** — *a defect that hides the evidence of itself*. The jsonb
double-encoding class corrupts data you can still query; this one removes the
diff, so review and audit both silently see nothing.

**The check caught itself first.** Its own `git ls-files -z` split was written
with the raw separator, so the very first CI run of the gate failed on the gate:
`backend/tests/noNulBytesInSource.test.mjs (first at byte 1943 of 2878)`. That is
the strongest evidence it works, and it is why the escape — not the byte — has
to be the habit: even the person writing the rule reached for the byte.

**Ref** - `fix/nul-byte-in-source`, 2026-08-14

## Five causes recurred after being written up, because a write-up is not a check [high]

**Symptom** — the same five faults kept coming back, each one already described
in this file and in a COE, some of them more than once:

1. **A pre-serialized value bound to a json/jsonb parameter.** Six occurrences
   in 15 days, one COE (docs/jsonb-double-encoding-coe.md), 22 hand-written
   warnings scattered through `backend/` — and TWO live violations still on
   main when this gate was written, one of them inside the repair script for
   the damage the class had already done.
2. **A read whose failure is discarded** (`const { data }` with no `error`,
   `.catch(() => {})`). Counted 785 four weeks before this; 954 when counted
   again. The class GREW by 169 sites after fifteen were fixed by hand and the
   fix was declared complete. Nothing had ever counted them.
3. **A parameter that decides, declared optional** — `companyId`, `itemCode`,
   `soItemId`, the idempotency key. Seven recorded occurrences. `?:` spells
   "omitted" and "nothing to say" identically, so a by-SKU exemption can be
   half-applied and typecheck stays green.
4. **A generator whose output is committed but is never re-run.** The codebase
   map generator crashed silently for three weeks; the map rotted while every
   dashboard stayed green.
5. **Searched columns without a trigram index.** Its checker existed — and
   until 2026-08-13 BOTH of its exit paths were `exit 0` and it was wired into
   no workflow at all. It could not fail, and nobody ran it.

**Root cause** — every one of these was already documented. The write-up was
read; the rule lived in prose; prose does not fail a build. The fifth is the
purest form: a check whose every exit path returns success is prose wearing the
clothes of a script.

**Fix** — five gates in `backend-typecheck`, the job that already finishes in
about a minute: `audit:jsonb-binds`, `audit:swallowed-reads` (a RATCHET — the
954 are pinned and may only fall), `audit:decision-params`, `audit:generators`,
`audit:trgm`. Each carries the entry it answers in a comment above it in
ci.yml. `audit:trgm` is deliberately NOT in either deploy workflow: it is a
static approximation, and a false positive must cost a conversation, never a
deploy.

The swallowed-read work that came in with this branch fixed 16 reads whose
failure silently AUTHORISES a write — including a quantity cap that lived
entirely inside `if (row) {…}`, so a failed read skipped the cap rather than
enforcing it.

**Class** — this entry defines the shape the classes are recorded in;
docs/bug-classes.md names each one with its count, its worst cost, and the
check that now fails on it.

**Ref** - `fix/bug-class-gates`, PR #2127 (with #2141), 2026-08-14

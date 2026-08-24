## The script written to undo a double-encoded jsonb re-encoded it, and only its own verification noticed [high]

**Symptom** — the apply run of `repair-array-shaped-variants.mjs` reported
success and damage on the same page:

```
array-shaped blocks remaining: 0 (was 7)
SO 9dc36f6f…: variants is string, fabricCode reads "(none)"
```

Seven production rows moved from one unreadable shape to another. No consumer
could read them before the run and none could after it.

**Root cause (traced, not guessed)** — the write was
`SET variants = $2::jsonb` with `JSON.stringify(obj)` bound. `postgres.js`
infers the bind type and sends the parameter **already typed jsonb**, so
`::jsonb` on it is a no-op: the serialized text is stored as a jsonb SCALAR
STRING instead of being parsed into an object. That is verbatim the failure
`docs/jsonb-double-encoding-coe.md` exists to record — *never let a serializer
near a jsonb parameter* — reproduced inside the repair written for it. The
second half is why it could have shipped silently: `arrayShapeCheck` asks only
`jsonb_typeof = 'array'`, so re-running it over seven fresh jsonb STRINGS
reports CLEAN.

**Fix** — `$2::text::jsonb`, and the `::text` is the whole point: it forces the
parameter to arrive as TEXT so the following `::jsonb` is a real PARSE. A local
`badShapeCheck` replaces `arrayShapeCheck` in this script and counts
`jsonb_typeof IN ('array','string')`; `unwrap()` accepts a jsonb string holding
an object as a first-class damage shape and recovers it with one parse; the
UPDATE's guard widens to the same pair.

**Where the fix actually landed** — PR #2118 was CLOSED, not merged: #2121
squash-merged its branch at 13:06. Verified by reading origin/main at
`de99056d5` rather than trusting the PR state —
`backend/scripts/repair-array-shaped-variants.mjs` carries `$2::text::jsonb`
(`:215`), the `IN ('array','string')` update guard (`:216`) and `badShapeCheck`
(`:45`). The apply that followed printed `variants is object, fabricCode reads
"HR805-40"` where the previous run had said `variants is string, fabricCode reads
"(none)"` while reporting the same 7 of 7.

**The class, for next time** — the check that caught this is the only reason it
is a two-hour bug instead of a permanent one, and it caught it for a specific
reason: **the verification asserted the SHAPE it had produced and re-read a key
out of it, rather than trusting the row count.** A repair that had verified "7 of
7 rows written" would have declared victory over seven rows it had just broken
differently. A verification that re-asserts the same predicate the UPDATE used is
not a verification.

**Ref** — 2026-08-13, PR #2118 (`fix/array-repair-double-encoded-again`), closed
as superseded; landed on `main` in #2121 (`d33ac7438`). Entry written 2026-08-14
from the diff and from origin/main. No module guide covers `backend/scripts/`.

---

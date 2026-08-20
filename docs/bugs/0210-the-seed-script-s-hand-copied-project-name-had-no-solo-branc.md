## The seed script's hand-copied project name had no solo branch — re-seeds could not converge [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** None reported. Found while shrinking `services/projects.ts`.

**The defect, against the code's OWN stated contract.**
`backend/scripts/seed-projects.mjs` carried its own `buildName()` under this
comment:

> Canonical project name format. Must match `deriveProjectName()` in
> services/projects.ts and the backfill in mig 071 so re-seeds converge on the
> same string.

It did not match. `deriveProjectName` forces the organizer slot to the literal
`SOLO` for a solo event **even when an organizer was picked** — a solo event is
by definition not organised by anyone. The hand copy had no such branch:

```js
const organizer = (row["ORGANIZER"] || "").trim() || "SOLO";
```

**And the same script reads the field it needed, twelve lines below**:
`EVENT_TYPE_ID[(row["EVENT TYPE"] ?? "").toUpperCase()]` stamps
`event_type_id = 2` for SOLO. So one row could be inserted as a solo event whose
NAME names an organizer, while the app would have named the same event
`... SOLO @ ...`.

Measured, not argued — same input through both:

```
app  / shared rule : SABAH [AKEMI] SOLO @ SURIA
seed / hand copy   : SABAH [AKEMI] KAI HAO @ SURIA
```

Two different names for one event, from a script whose comment asked for
convergence. This is the failure `CLAUDE.md` names directly: a rule hand-copied
into a `.mjs` because it cannot import TypeScript, with a comment instead of a
check holding the two together.

**Fix.** The two format rules moved out of `services/projects.ts` into
`src/services/project-naming.ts`, with a plain-JS mirror at
`scripts/lib/project-naming.mjs` and `tests/projectNamingMirror.test.ts` pinning
them across seven inputs chosen so a dropped rule shows as a MISMATCH rather
than as two functions agreeing on easy cases. `seed-projects.mjs` now imports the
mirror instead of re-implementing. Exactly the arrangement
`scripts/lib/variant-axes.mjs` already uses, and for the same reason.

21 tests where there were none. Proven red by forcing `isSolo` false in the
mirror — a mutation that stays syntactically valid, because the first attempt
produced a parse error and the suite reported "no tests", which is a guard dying
with the thing it guards rather than catching it.

**NOT claimed, and it is a question for the owner:** whether any ALREADY-SEEDED
project carries the organizer spelling where it should say SOLO. That needs a
production read, and nothing here has looked.

`services/projects.ts` 3210 -> 3137 lines, ceiling follows.

**Ref.** 2026-08-15, file-size debt paydown.

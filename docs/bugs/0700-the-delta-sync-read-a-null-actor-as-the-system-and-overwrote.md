## The delta sync read a null actor as the system and overwrote people's edits [high]

**Symptom.** Nothing anybody could see, which is the point. A salesperson
corrects a migrated sales order's header — the agent it is credited to, the
delivery address — and the next `sync-ac-delta LANES=hdr` puts AutoCount's older
value back. No refusal, no conflict line, no count. The order simply reads what
it read before the person touched it, and the only trace is in an audit log
nobody opens. This is the risk `docs/migrated-so-lock.md` was written to hold
shut, and it is the half that had not been fixed.

**Root cause (traced).** `backend/scripts/sync-ac-delta.mjs` section 6 decided
authorship with

```
if (!r.actor_id || String(r.actor_id) === SYS_ACTOR) { sysAuthored++; continue; }
```

— any audit row whose `actor_id` is NULL counted as the SYSTEM's, and the field
stayed writable. A null actor is a normal shape for a PERSON's row in this
schema, and three writers produce one:

* `backend/src/scm/routes/so-amendments.ts:262` passes `actorId: null` **on
  purpose** ("actorId is left null so nothing implies the pinned system row
  acted") with the real caller's name in `actor_name_snapshot`.
* `backend/src/scm/routes/so-handover.ts:191` passes
  `actorId: user?.id ?? null, actorName: user?.user_metadata?.name ?? null` —
  both null whenever that session's user object is thin. That route writes
  `salesperson_id` and `agent`, which are exactly two of the fields this lane
  copies from the book.
* `backend/src/scm/lib/entity-audit.ts:178` resolves the actor through
  `resolveCallerStaffId` and leaves NULL when the caller has no staff row.

The correct rule already existed and had been RUN:
`backend/scripts/check-so-open-for-new.mjs` was corrected the same day after
production run `34183368917` reported 50 "touched" migrated orders that were all
the stock-allocation cron. It settles authorship on the row's own attribution —
system is `actor_id = <migration actor>` OR `(actor_id IS NULL AND
actor_name_snapshot ILIKE 'system%')`, everything else is a person, an
unattributed row included. The sync never used it.

**Fix.** The rule has one home,
`backend/scripts/lib/ac-human-edit.mjs` (`isSystemAuditRow`, whose deciding
parameter `migrationActorId: string | null` is REQUIRED, so no call site can
inherit an answer). `sync-ac-delta.mjs` now uses it in every lane, and every
refusal prints the document, the line, both values and WHO instead of a count.
`version > 1` remains only as an unrelated conservatism on the desc2 and payment
lanes and is printed apart from the authorship number; it never decides
authorship anywhere.

Pinned by `backend/tests/acHumanEdit.test.mjs`, PROVED RED on the unfixed tree
(27 tests, 6 failed / 21 passed before the fix; 27 passed after) — the six reds
were the call-site assertions, which is where the data loss lived.

**Ref.** fix/sync-human-edit-guard, 2026-09-08.

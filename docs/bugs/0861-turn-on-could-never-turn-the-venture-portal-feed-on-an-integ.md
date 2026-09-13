## Turn on could never turn the Venture Portal feed on: an integer user id was written into a uuid column [high]

**Symptom.** The owner generated an API key, saved the receiver address, pressed
**Turn on** — and the page answered:

> Not saved: invalid input syntax for type uuid: "90"

The switch stayed **Off**. Reported with a screenshot, in his words: *"cant work"*.
Everything either side of it worked: the key minted and showed as `····k027 ·
generated 13/09/2026 17:48`, and the address saved. Only the switch was dead —
**for everybody, from the day the page shipped (#3751), until now.** The feed has
therefore never been turned on, which is also why nothing noticed.

**Root cause (traced).** `scm.app_config.updated_by` is a **uuid**:

```
backend/src/db/migrations-pg/0272_scm_app_config.sql:21   updated_by  uuid
```

`PUT /scope` wrote the caller's Houzs user id into it —
`updated_by: c.get('houzsUser')?.id ?? null` at
`backend/src/scm/routes/venture-portal-feed.ts:423` — and `houzsUser.id` is an
INTEGER, the `public.users` id (`backend/src/scm/env.ts` declares `id: number`).
Postgres refused the whole upsert. The owner's id is `90`, which is the `"90"` in
the message.

Traced by reading the column type against the value, after the screenshot named
both. The error text is the database's own, so no reproduction was needed and none
was invented.

**Why every gate here missed it.** This is a disagreement between a COLUMN TYPE and
a VALUE, and the only thing that can see it is the database. The SCM PostgREST
client is `any`, so `tsc` had no type to check. No test covers this route. The page
behaved perfectly — it surfaced the server's own sentence rather than swallowing
it, which is the one reason the owner could tell us what was wrong instead of
reporting "the button does nothing". `check-docs-drift`, the lint ratchet, the
working-agreement gate and CI all read CODE; CLAUDE.md's rule that *reading code is
not evidence about production* is exactly this shape, and the cost was one blocked
owner.

Nine other call sites write a `houzsUser` integer into a `created_by`/`updated_by`
column (`git grep -nE "(updated_by|created_by)[^,;]*houzsUser" -- backend/src`).
They are NOT the same bug where checked: `scm.lorry_service_records.created_by` is
`bigint` (mig 0121:143) and deliberately records that integer. The column type is
what decides, per file — **not** the call-site shape.

**Fix.** `updated_by` is now `await resolveCallerStaffId(sb, houzsUser.id)`
(`scm/lib/salesScope.ts`), which resolves the caller's real `scm.staff` uuid via
`staff.user_id` and answers `null` when there is no staff row. Both are valid for
a uuid column, so the upsert cannot fail on this field again.

**The fix is a TYPE, not a reminder.** `resolveCallerStaffId` is declared
`Promise<string | null>`, so a number can no longer reach that field from this call
site without failing the compile — which is the only guard that would have caught
the original, since no test and no checker in this repo can see a column type.

Who turned the feed on now also goes to `audit_events`
(`venture_portal.scope.set`, with the real integer actor and the scope value),
because this setting decides whose sales orders — with their costs and margins —
leave the system for somebody's commission, a delivery cannot be recalled, and
`updated_by` is null for anyone without a staff row.

**Lesson.** The page surfacing the server's verbatim refusal is what made this
findable in one screenshot. Keep that: a generic "could not save" here would have
cost days. And when a write targets a column you did not declare, read the
migration for its TYPE before trusting the value you have.

**Ref.** fix/vp-feed-turn-on-writes-int-into-uuid, 2026-09-13. The feature shipped
in #3773; this is the switch it could not flip.

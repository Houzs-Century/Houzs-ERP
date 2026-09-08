## The corrected authorship rule still called every human sales-order edit the system [critical]

<!-- area: AutoCount sync + write-back -->

**Symptom.** None visible, again — which is the point. `#3205` landed
`backend/scripts/lib/ac-human-edit.mjs` to stop the AutoCount delta sync writing
the account book's older value over a person's edit, and it fixed the half it
set out to fix (a NULL actor read as "the system did it", `docs/bugs/0700`). The
rule it settled on kept a second arm:

```js
SYSTEM  :=  actor_id = MIGRATION_ACTOR_ID
        OR  (actor_id IS NULL AND actor_name_snapshot ILIKE 'system%')
```

`MIGRATION_ACTOR_ID` is `00000000-0000-4000-8000-000000000001`. That first arm
matches **every sales-order edit a person makes in the browser**, so on the lane
that matters most the guard still refused nothing.

**Root cause (traced, and MEASURED rather than read).** Two facts, in opposite
directions, and both are now assertions rather than sentences:

1. **The uuid is on every human edit.** `backend/src/scm/middleware/auth.ts`
   replaces `c.get('user')` with a pinned identity whose `id` is that uuid, for
   every authenticated SCM caller — a type shim, because the ported 2990 routes
   expect a uuid and Houzs users are integers. All 21 `recordSoAudit` call sites
   in `backend/src/scm/routes/mfg-sales-orders.ts` pass `actorId: user.id`.

   **Proved by RUNNING the middleware**, not by quoting it:
   `backend/src/scm/shared/audit-author.test.ts` builds a Hono app, sets a
   caller whose real Houzs id is `4242`, runs `supabaseAuth`, and asserts what
   comes out — `c.get('user').id` is the pinned uuid and `c.get('houzsUser').id`
   is `4242`. 16 tests, green, 2026-09-08 15:15 MYT. This claim has now been
   wrong twice in this repository in opposite directions, each time settled by
   reading a file, so it is a live assertion from here on.

2. **The uuid is on no migration row at all.** Nothing writes `actor_id` into
   either audit table. Exactly two scripts INSERT into one —
   `backend/scripts/backfill-2990-delivered-dos.mjs:124` and
   `backend/scripts/repair-so-fee-line-integrity.mjs:317` — and both omit the
   column entirely, naming themselves in `actor_name_snapshot` instead. The
   fixture that pinned the old behaviour (`MIGRATION_ROW`, carrying
   `actorId: MIGRATION_ACTOR_ID, actorName: 'AutoCount import'`) described a row
   shape this codebase does not produce.

So the arm refused nothing it was aimed at and skipped everything it was meant
to catch.

**Fix.** The authorship question now has ONE home for the whole repo —
`backend/src/scm/shared/audit-author.ts` — and the rule is the writer's own
self-declaration and nothing else:

> A row is MACHINE-written when `actor_name_snapshot` starts with "system".
> Everything else is a PERSON, including an unattributed row.

`actor_id` is not consulted anywhere, because it carries no information.
`ac-human-edit.mjs` keeps everything that is not a decision — the field
aliasing, the per-(document, field) index, the refusal wording — and delegates
`isSystemAuditRow` to that module; its `migrationActorId` parameter is removed
rather than kept, because a decision-shaped argument that decides nothing is
worse than none. The module lives under `src/scm/shared/` and not
`scripts/lib/` for one mechanical reason: the go-live change log runs in the
Worker and a Worker bundle cannot import out of `backend/scripts`, while a
script CAN import a `.ts` — so that is the only direction in which all three
callers get one answer.

Proved RED then GREEN at both levels. `tests/acHumanEdit.test.mjs` now asserts
that a salesperson's browser edit — pinned actor id and all — vetoes its own
field and leaves the fields nobody touched writable (29 tests, green). The old
`MIGRATION_ROW` fixture is corrected to the shape a backfill really writes.

**What this does NOT claim.** Nothing here was run against production. The delta
sync has not been dispatched from this branch. **UNTESTED against prod data.**

**Ref.** `feat/golive-change-log-and-sync-guard`, 2026-09-08. Builds on `#3205`
(`docs/bugs/0700`), not a replacement for it.

## New Project died on duplicate key because identity sequences fell behind their tables [high]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, 2026-08-24: "i cant create project, fix it." Every New
Project click failed behind a generic "Something went wrong". Second occurrence
in three days — the same fault was repaired by hand on 2026-08-21.

**Root cause (traced, not guessed).** Live Postgres log on prod
(`anogrigyjbduyzclzjgn`, `source='postgres_logs'`) at the exact minute of the
owner's failed click, 2026-08-24T06:35:35Z: `duplicate key value violates unique
constraint "project_checklist_sections_pkey"`. A live sweep of every public
sequence against its owning table found three sitting BEHIND their table —
`project_checklist` (sequence 10685, table already at 10769),
`project_checklist_sections` (3456 vs 3479) and `project_finance.project_id`
(461 vs 2248).

Why they can fall behind silently: every one of these id columns is `GENERATED
BY DEFAULT AS IDENTITY` (confirmed via `information_schema.columns
.identity_generation`), and "BY DEFAULT" means Postgres ACCEPTS an explicit id
without advancing the sequence and without warning. So any bulk copy that
carries its own ids — twin-brand duplications, event CSV imports, checklist
copies — poisons the sequence at write time and reports nothing. The bill lands
later on the next ORGANIC insert: `instantiateChecklistFromEventType`
(`services/projects.ts:257`) clones template sections and items WITHOUT
supplying ids, so it draws from the poisoned sequence and collides.

The app itself is not the writer of explicit ids — its clone path inserts
`(project_id, name, sort_order, display_mode)` only.

Second-order damage: `createProject` is not wrapped in a transaction, so each
failed click leaves an EMPTY project row (0 sections, 0 tasks) on the calendar.
One was left this time, id 2248.

**Fix.** Two parts, and only the first is a real fix.

1. STOPGAP, applied live: `setval` on the three drifted sequences. Verified on a
   fresh read — drift 0 on all three — then proved by insert: a probe row into
   each of the two tables that were failing received free ids 3481 and 10771 and
   was deleted again. Project creation works.
2. ROOT: the expensive part was never the repair, it was the diagnosis, and it
   was paid twice. `backend/scripts/check-sequence-drift.mjs` (read-only; sweeps
   all 85 public sequences via `pg_depend`, so it catches
   `project_finance.project_id` whose sequence hangs off a non-`id` column, and
   also lists projects with no checklist as the visible half of the fault) plus
   `backend/scripts/repair-sequence-drift.mjs` (MODE=plan default,
   CONFIRM=repair-sequences, fresh-connection shape verify that draws a real
   `nextval` and asserts the table does not already hold it). Both are
   `workflow_dispatch` workflows so nobody handles the production DSN.

**NOT fixed, deliberately — the durable options are the owner's call.** Making
these columns `GENERATED ALWAYS AS IDENTITY` would make the silent poisoning
impossible (an explicit id is then refused outright unless the writer says
`OVERRIDING SYSTEM VALUE`), but it breaks every import script that legitimately
carries ids until each is updated. Wrapping `createProject` in a transaction
would stop the empty-project debris independently of any of this.

**Ref.** fix/sequence-drift-detector, 2026-08-24. Prior occurrence 2026-08-21,
repaired by hand with no detector left behind, which is why it recurred.

## Service Maintenance's SLA Hours cell saved, said OK, and changed nothing [medium]

<!-- area: Service cases (ASSR) -->

**白话.** 「服务维护 -> Priorities」那一栏「SLA hrs」，是给主管改「这个紧急程度要几个
小时内处理完」用的。改了会显示存好了 —— 但系统开新案子的时候根本没去看那一栏，一直
用程式里写死的数字。因为写死的数字刚好跟当初预设的一样（低 336 小时 / 普通 168 /
高 72 / 紧急 24），所以看起来完全正常，直到有人真的去改它 —— 改完没有任何反应，也没有
任何错误讯息。现在改了就算数：**新开的案子**跟**改紧急程度的案子**都会用主管填的时数。
**已经开好的案子不会重算**，这一点跟当初 065 的说明一致，没有变。另外那一格现在会挡掉
乱填的值（0、负数、小数、文字），以前是照单全收然后默默忽略。

**Symptom.** A manager edits the SLA Hours cell on a priority in Service
Maintenance. The row saves, the API answers `{ ok: true }`, the new number is
displayed on reload — and every case created afterwards still uses the old
window. No error, no log, no signal of any kind.

**Root cause (traced in source, not guessed).** `assr_priorities.sla_hours` had
a complete WRITE path and no READ path. `ServiceSettings.tsx` offers the cell
("SLA window in hours; blank = use module default"); `routes/assr.ts` INSERTs it
on `POST /lookups/priorities` and allows it on `PATCH /lookups/priorities/:id`.
But both places that COMPUTE an SLA — `createAssrCase` and the priority-change
arm of `patchAssrCase` in `services/assr.ts` — called `slaHoursFor()`, whose
entire body was a lookup in the hardcoded `SLA_HOURS_BY_PRIORITY`. Nothing in
`backend/src` ever selected the column. The mig 065 seed writes exactly the
constant's values (low 336 / normal 168 / high 72 / urgent 24), so the two
agreed for every unedited row and the gap was invisible until somebody edited
one. Migration `065_assr_lookups.sql:42` calls the column "optional override of
slaHoursFor()" and `:66-68` says editing it makes new cases pick up the change;
both sentences were false from the day they were written.

**Fix.** New `backend/src/services/assrSla.ts` holds the case-level SLA clock —
the read beside the write validation, so they cannot drift apart again, and
because both former homes were at their file-size ceiling. Its
`slaHoursForPriority(env, slug)` reads `assr_priorities.sla_hours`
for the slug and falls back to `slaHoursFor()` when the cell is blank, the row
is missing, the value is junk, or the read throws — the same try/catch posture
`lookupStageTargetDays()` already uses, so a config read can never fail a case
create. No `active` predicate, matching that same function: deactivating a
priority must not swing the SLA of a case still carrying it. Both call sites now
use it. **Existing deadlines are NOT recomputed** — mig 065 already said so and
that stays true. `sla_hours` writes are now validated (positive whole number, or
blank): the PATCH allow-list previously bound `body[k] ?? null` straight through,
so `"abc"` stored successfully and was then silently ignored at read time, which
is this same defect a second time.

**Why live rather than deleted.** Two honest fixes existed. Making it live wins
because the promise is written in four places (the migration comment, the column
comment, the section description "The SLA Hours column overrides the default
per-priority SLA window", and the cell title) and because the sibling axis on
the SAME table — per-priority per-stage targets, mig 082 — is already read live
by `lookupStageTargetDays()`. Deleting the cell would have left `assr_priorities`
as a live config table with exactly one inert column, and left the case-level
clock as the only SLA a manager cannot tune while the per-stage clock is
manager-editable through the Lead Time Portal.

**Production values: UNKNOWN, and now answerable without asking.** Whether any
priority row was ever edited away from the 065 seed lives only in production.
`backend/scripts/check-assr-sla-priorities.mjs` +
`.github/workflows/assr-sla-priorities-check.yml` (Actions -> **Service SLA
priorities check (read-only)**) print each priority's stored value beside the
fallback and say plainly whether making the column live moves any deadline. One
SELECT, no writes, exit 0 for every legitimate answer. **UNTESTED — a
`workflow_dispatch` workflow cannot be dispatched until it is on the default
branch, so this one has never run. It is not proven shipped until it has.**

**Found while fixing it, NOT fixed here.** `assr_cases.priority` carries
`CHECK (priority IN ('low','normal','high','urgent'))`
(`backend/src/db/migrations/010_assr_redesign.sql:16`, restated by `074:93`), so
Service Maintenance can ADD a priority, save it, list it in the picker — and
every case create using it fails. That is a second control of this same shape.
Widening a CHECK is a schema decision with its own migration and this PR must
not weaken a constraint as a side effect; the constraint is pinned by an
assertion in `backend/tests/assrSlaHoursOverride.test.ts` so whoever widens it
reads this note first.

**Guards, each proved RED before being trusted.**
`backend/tests/assrSlaHoursOverride.test.ts` — putting `slaHoursFor` back at the
two call sites fails 2 of its 6; deleting the `normalizeSlaHours` branch from
PATCH fails 1. `backend/tests/assrSlaFallbackMirror.test.ts` keeps the
prod-check script's hand-copied fallback table equal to the service's — changing
`high: 72` to `71` in the script fails it — and asserts its own regex matched,
so a verdict computed over nothing cannot read as a pass.

**Ref.** `fix/assr-sla-hours-override`, 2026-08-20.

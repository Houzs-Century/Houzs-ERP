## The alarm for a cause we never found, and a guard that only ran on Linux [medium]

Two unrelated things, both about a check that is not measuring what it looks
like it measures.

### 1. No alarm existed for the DO->SO link corruption

**Symptom.** None — that is the point. On 2026-08-17, 26 live delivery lines
were found with `so_item_id` NULL under a DO whose header still named the order
(#2355 has the trace). #2225 closed the write-side hole and #2355 gave both
coverage engines a second reading off `delivery_orders.so_doc_no`, so the
SYMPTOM — MRP re-ordering goods already delivered — is covered twice.

**Root cause of the remaining exposure (stated, not guessed).** The MECHANISM
was never identified, and both closed theories are refuted by the data:

- the FK is `ON DELETE SET NULL`, so deleting an SO line blanks the pointer —
  but every affected SO line is still present, carrying its ORIGINAL
  `created_at` (2990-SO-2607-012's seven lines still read
  `2026-07-12 11:03:50.664`, the second the order was created). Nothing was
  deleted and re-inserted;
- #2225's diagnosis was a client omitting the field on write — but
  2990-DO-2608-008 came through `POST /from-sos`, which sets `so_item_id`
  explicitly, and its SO flipped to DELIVERED six seconds later, a transition
  unreachable without the links.

A third mechanism blanked them and it is still live. **The fix makes it
silent**: before, the corruption announced itself as a wrong MRP row somebody
complained about; now the fallback absorbs it and nothing looks wrong.

**Fix.** Instrumentation, not a repair:

- `backend/scripts/do-link-orphan-sentinel.mjs` + a scheduled workflow. Read-only,
  exits non-zero on alarm so the owner gets the failed-workflow email (the same
  and only notifier `mirror-sentinel.yml` uses). Baseline is a committed 1 —
  the one deliberately refused pillow on 2990-DO-2607-013 — and raising that
  number to get green is called out in both files as the thing not to do.
  It also alarms on a stricter shape the fallback cannot reach: a line with no
  per-line link AND no `so_doc_no`, against which stock moved. Zero today.
- Migration 0302 logs every SO-line DELETE with the PostgREST JWT claims, the
  db role, `application_name`, pid and txid. It is a FALSIFICATION TEST as much
  as a log: if the sentinel fires and this table has no matching row, the FK
  path is disproved and that theory can finally be retired.

Deliberately learned from `mirror-drift-sentinel.mjs`, whose header records
months of `SKIP` + exit 0 against secrets nobody set, with a real stall sitting
under the green tick. This one exits **1** when `DATABASE_URL` is absent: a
missing secret is a misconfiguration, not a reason to report health.

### 2. `unlinked-line-edit-guard.test.ts` could not run on Windows

**Symptom.** `npm run test:light` failed 5 assertions locally with
`handler end not found in grns.ts` — on a clean checkout of main, with no local
changes. CI was green throughout.

**Root cause.** `handlerSlice` finds a route handler's end with
`rest.search(/\n\}\)?;\n/)`. This repo is developed on Windows, where the
checkout is CRLF, so the LF-only pattern matched nothing and every slice came
back `-1`. Linux CI, with LF, never saw it.

**Fix.** `/\r?\n\}\)?;\r?\n/`. Same family as the shebang trap in #2062, and the
inverse of the usual danger: this one failed LOUDLY rather than passing empty,
so nothing was silently unmeasured — but the whole local suite was unusable on
the platform the repo is developed on, which is how a red local run stops being
information.

**Ref.** PR (branch `chore/do-link-orphan-sentinel`), 2026-08-17.

## A case a sales rep raised could vanish from their My Cases list [medium]

<!-- area: Service cases (ASSR) -->

**Symptom.** "Sales can't create service case" (owner, 2026-08-21, reporting for
Shawn — a Sales Manager covering several resigned agents' customers). Creation
itself worked: the POST succeeded, the rep landed on the new case's detail once
— and then the case never appeared in My Cases again, which reads as "create
failed". The same list also showed none of the cases belonging to the customers
he took over.

**Root cause (traced).** `/api/assr/my-cases` (backend/src/routes/assr.ts)
selected rows by ONE rule: `LOWER(sales_agent) LIKE %<subtree name>%`, OR-ed
over the caller's reporting-subtree names. Two ways that loses real cases,
both confirmed against production data:

1. A created case's `sales_agent` is stamped from the SO — the resigned
   agent's name (e.g. KINGSLEY, a disabled account outside the caller's
   subtree) — so the creator's own case fails every name arm. `created_by`
   is stamped on every create and was never consulted.
2. The match was one-directional over raw text, so AutoCount spellings that
   differ from `users.name` by spacing or a dropped surname orphaned whole
   sets: PEIFEN vs "Pei Fen" (12 live cases), WEIPIN vs "Wei Pin" (7),
   SHELDON vs "Sheldon Tan" (18), LUIS vs "Luis Teo" (13).

**Fix.** The row rule moved to `services/assrMyCases.ts` (`myCasesPredicate`)
and gained two arms: `created_by = caller`, and space-stripped comparison in
both directions (agent-contains-name and name-contains-agent, the reverse arm
floored at 4 stripped characters so initials like "CH" cannot match half the
org). Space-stripping both sides is strictly widening for the original arm, so
no previously matched pair is lost. Pinned by
`backend/tests/assrMyCasesScope.test.ts`, which executes the predicate against
the real D1 schema. Proved RED: with the builder temporarily swapped back to
the pre-change rule, the run came back 5 failed / 4 passed — the two
spelling-gap tests and the three created_by tests are the failures, and the
kept-behaviour tests stay green.

**Ref.** fix/assr-mycases-created-by-0821, 2026-08-21.
